// Copyright (C) 2024 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import {
  ActionEventArg,
  DamageInfo,
  DamageOrHealEventArg,
  EventAndRequest,
  EventArg,
  HealInfo,
  InitiativeSkillEventArg,
  SkillInfo,
  SwitchActiveEventArg,
  TriggeredSkillDefinition,
  UseSkillEventArg,
  ZeroHealthEventArg,
} from "./base/skill";
import { CharacterState, GameState, stringifyState } from "./base/state";
import { Aura, DamageType, ExposedMutation, Reaction } from "@gi-tcg/typings";
import {
  allEntities,
  allSkills,
  checkImmune,
  getActiveCharacterIndex,
  getEntityArea,
  getEntityById,
} from "./utils";
import { flip } from "@gi-tcg/utils";
import { DetailLogType, IDetailLogger } from "./log";
import { Writable } from "./utils";
import {
  GiTcgIoNotProvideError,
  InternalNotifyOption,
  InternalPauseOption,
  StateMutator,
} from "./mutator";

interface IoDuringSkillFinalize {
  logger: IDetailLogger;
  requestSwitchCard(who: 0 | 1): Promise<number[]>;
  requestReroll(who: 0 | 1): Promise<number[]>;
  chooseActive(who: 0 | 1, state: GameState): Promise<CharacterState>;
  onNotify(opt: InternalNotifyOption): void;
  onPause(opt: InternalPauseOption): Promise<void>;
}

interface IoAndState extends IoDuringSkillFinalize {
  readonly state: GameState;
}

export type GeneralSkillArg = EventArg | InitiativeSkillEventArg;

export type PreviewResult = readonly [newState: GameState, completed: boolean];

export class SkillExecutor extends StateMutator {
  private constructor(
    state: GameState,
    private readonly _io?: IoDuringSkillFinalize,
  ) {
    super(state, { logger: _io?.logger });
  }

  private get io() {
    if (!this._io) {
      throw new GiTcgIoNotProvideError();
    }
    return this._io;
  }

  protected override onNotify(opt: InternalNotifyOption) {
    this._io?.onNotify(opt);
  }
  protected override async onPause(opt: InternalNotifyOption) {
    await this._io?.onPause(opt);
  }
  protected override async requestReroll(who: 0 | 1): Promise<number[]> {
    if (this._io) {
      return this._io.requestReroll(who);
    } else {
      throw new GiTcgIoNotProvideError();
    }
  }
  protected override async requestSwitchCard(who: 0 | 1): Promise<number[]> {
    if (this._io) {
      return this._io.requestSwitchCard(who);
    } else {
      throw new GiTcgIoNotProvideError();
    }
  }

  async finalizeSkill(
    skillInfo: SkillInfo,
    arg: GeneralSkillArg,
  ): Promise<void> {
    if (this.state.phase === "gameEnd") {
      return;
    }
    using l = this.subLog(
      DetailLogType.Skill,
      `Using skill [skill:${skillInfo.definition.id}]${
        skillInfo.charged ? " (charged)" : ""
      }${skillInfo.plunging ? " (plunging)" : ""}`,
    );
    this.log(
      DetailLogType.Other,
      `skill caller: ${stringifyState(skillInfo.caller)}`,
    );
    const callerArea = getEntityArea(this.state, skillInfo.caller.id);
    const skillDef = skillInfo.definition;

    const preExposedMutations: ExposedMutation[] = [];
    if (
      skillInfo.caller.definition.skills.find((sk) => sk.id === skillDef.id)
    ) {
      preExposedMutations.push({
        type: "triggered",
        id: skillInfo.caller.id,
      });
    }
    if (skillInfo.definition.triggerOn === null) {
      preExposedMutations.push({
        type: "useCommonSkill",
        who: callerArea.who,
        skill: skillDef.id,
      });
    }
    this.notify({
      mutations: preExposedMutations,
    });

    const [newState, eventList] = (0, skillDef.action)(
      this.state,
      {
        ...skillInfo,
        logger: this._io?.logger,
        onNotify: (opt) => this.onNotify(opt),
      },
      arg as any,
    );
    this.resetState(newState);

    await this.notifyAndPause();

    const damageEvents = eventList.filter((e) => e[0] === "onDamageOrHeal");
    const nonDamageEvents = eventList.filter((e) => e[0] !== "onDamageOrHeal");

    const damageEventArgs: DamageOrHealEventArg<DamageInfo | HealInfo>[] = [];
    const zeroHealthEventArgs: ZeroHealthEventArg[] = [];
    const failedPlayers = new Set<0 | 1>();
    for (const [, arg] of damageEvents) {
      if (arg.damageInfo.causeDefeated) {
        // Wrap original EventArg to ZeroHealthEventArg
        const zeroHealthEventArg = new ZeroHealthEventArg(
          arg._state,
          arg.damageInfo,
        );
        if (checkImmune(this.state, zeroHealthEventArg)) {
          zeroHealthEventArgs.push(zeroHealthEventArg);
        } else {
          const { id } = arg.target;
          const ch = getEntityById(this.state, id, true) as CharacterState;
          const { who } = getEntityArea(this.state, id);
          if (ch.variables.alive) {
            this.log(
              DetailLogType.Primitive,
              `${stringifyState(ch)} is defeated (and no immune available)`,
            );
            this.mutate({
              type: "modifyEntityVar",
              state: ch,
              varName: "alive",
              value: 0,
            });
            this.mutate({
              type: "modifyEntityVar",
              state: ch,
              varName: "energy",
              value: 0,
            });
            this.mutate({
              type: "modifyEntityVar",
              state: ch,
              varName: "aura",
              value: Aura.None,
            });
            this.mutate({
              type: "setPlayerFlag",
              who,
              flagName: "hasDefeated",
              value: true,
            });
            const player = this.state.players[who];
            const aliveCharacters = player.characters.filter(
              (ch) => ch.variables.alive,
            );
            if (aliveCharacters.length === 0) {
              failedPlayers.add(who);
            }
          }
        }
        damageEventArgs.push(zeroHealthEventArg);
      } else {
        damageEventArgs.push(arg);
      }
    }
    if (failedPlayers.size === 2) {
      this.log(
        DetailLogType.Other,
        `Both player has no alive characters, set winner to null`,
      );
      this.mutate({
        type: "changePhase",
        newPhase: "gameEnd",
      });
      await this.notifyAndPause();
      return;
    } else if (failedPlayers.size === 1) {
      const who = [...failedPlayers.values()][0];
      this.log(
        DetailLogType.Other,
        `player ${who} has no alive characters, set winner to ${flip(who)}`,
      );
      this.mutate({
        type: "changePhase",
        newPhase: "gameEnd",
      });
      this.mutate({
        type: "setWinner",
        winner: flip(who),
      });
      await this.notifyAndPause();
      return;
    }
    const safeDamageEvents = damageEventArgs.filter(
      (arg) => !arg.damageInfo.causeDefeated,
    );
    const criticalDamageEvents = damageEventArgs.filter(
      (arg) => arg.damageInfo.causeDefeated,
    );
    if (criticalDamageEvents.length > 0) {
      await this.notifyAndPause();
    }

    for (const arg of zeroHealthEventArgs) {
      await this.handleEvent(["modifyZeroHealth", arg]);
      if (arg._immuneInfo !== null) {
        this.log(
          DetailLogType.Primitive,
          `${stringifyState(arg.target)} is immune to defeated. Revive him to ${
            arg._immuneInfo.newHealth
          }`,
        );
        const healValue = arg._immuneInfo.newHealth;
        const healInfo: HealInfo = {
          type: DamageType.Heal,
          healKind: "revive",
          source: arg._immuneInfo.skill.caller,
          via: arg._immuneInfo.skill,
          target: arg.target,
          expectedValue: healValue,
          value: healValue,
          causeDefeated: false,
          fromReaction: null,
        };
        this.mutate({
          type: "modifyEntityVar",
          state: arg.target,
          varName: "health",
          value: healValue,
        });
        await this.notifyAndPause({
          mutations: [
            {
              type: "damage",
              damage: {
                type: healInfo.type,
                value: healInfo.value,
                target: healInfo.target.id,
              },
            },
          ],
        });
        const healEventArg = new DamageOrHealEventArg(arg._state, healInfo);
        await this.handleEvent(["onDamageOrHeal", healEventArg]);
      }
    }

    if (
      skillInfo.caller.definition.type === "character" &&
      skillDef.triggerOn === null
    ) {
      // 增加此回合技能计数
      const ch = getEntityById(
        this.state,
        skillInfo.caller.id,
        true,
      ) as CharacterState;
      this.mutate({
        type: "pushRoundSkillLog",
        // intentional bug here: 使用技能发起时的定义 id 而非当前的定义 id
        // e.g. 艾琳不会对导致变身的若陀龙王的技能计数
        caller: /* ch */ skillInfo.caller as CharacterState,
        skillId: skillInfo.definition.id,
      });
      // 增加充能
      if (skillDef.gainEnergy) {
        if (ch.variables.alive) {
          this.log(
            DetailLogType.Other,
            `using skill gain 1 energy for ${stringifyState(ch)}`,
          );
          const currentEnergy = ch.variables.energy;
          const newEnergy = Math.min(currentEnergy + 1, ch.variables.maxEnergy);
          this.mutate({
            type: "modifyEntityVar",
            state: ch,
            varName: "energy",
            value: newEnergy,
          });
          await this.notifyAndPause();
        }
      }
    }

    await this.handleEvent(...nonDamageEvents);
    for (const arg of safeDamageEvents) {
      await this.handleEvent(["onDamageOrHeal", arg]);
    }
    for (const arg of criticalDamageEvents) {
      await this.handleEvent(["onDamageOrHeal", arg]);
    }
    // 接下来处理出战角色倒下后的切人
    // 仅当本次技能的使用造成倒下时才会处理
    if (criticalDamageEvents.length === 0) {
      return;
    }
    const switchEvents: [
      null | Promise<SwitchActiveEventArg>,
      null | Promise<SwitchActiveEventArg>,
    ] = [null, null];
    for (const who of [0, 1] as const) {
      const player = this.state.players[who];
      const [activeCh] = player.characters.shiftLeft(
        getActiveCharacterIndex(player),
      );
      if (activeCh.variables.alive) {
        continue;
      }
      this.log(
        DetailLogType.Other,
        `Active character of player ${who} is defeated. Waiting user choice`,
      );
      switchEvents[who] = this.io.chooseActive(who, this.state).then(
        (to) =>
          new SwitchActiveEventArg(this.state, {
            type: "switchActive",
            who,
            from: activeCh,
            to,
            fromReaction: false,
          }),
      );
    }
    const args = await Promise.all(switchEvents);
    const currentTurn = this.state.currentTurn;
    for (const arg of args) {
      if (arg) {
        using l = this.subLog(
          DetailLogType.Primitive,
          `Player ${arg.switchInfo.who} switch active from ${stringifyState(
            arg.switchInfo.from,
          )} to ${stringifyState(arg.switchInfo.to)}`,
        );
        this.mutate({
          type: "switchActive",
          who: arg.switchInfo.who,
          value: arg.switchInfo.to,
        });
        this.notify({
          mutations: [
            {
              type: "switchActive",
              who: arg.switchInfo.who,
              id: arg.switchInfo.to.id,
              definitionId: arg.switchInfo.to.definition.id,
              via: null,
            },
          ],
        });
      }
    }
    for (const who of [currentTurn, flip(currentTurn)]) {
      const arg = args[who];
      if (arg) {
        await this.handleEvent(["onSwitchActive", arg]);
      }
    }
  }

  async handleEvent(...actions: EventAndRequest[]) {
    for (const [name, arg] of actions) {
      if (name === "requestReroll") {
        using l = this.subLog(
          DetailLogType.Event,
          `request player ${arg.who} to reroll`,
        );
        await this.reroll(arg.who, arg.times);
      } else if (name === "requestSwitchHands") {
        using l = this.subLog(
          DetailLogType.Event,
          `request player ${arg.who} to switch hands`,
        );
        await this.switchCard(arg.who);
      } else if (name === "requestUseSkill") {
        using l = this.subLog(
          DetailLogType.Event,
          `another skill [skill:${arg.requestingSkillId}] is requested:`,
        );
        const player = this.state.players[arg.who];
        const activeCh = player.characters[getActiveCharacterIndex(player)];
        const callerArea = getEntityArea(this.state, activeCh.id);
        if (
          activeCh.entities.find((et) =>
            et.definition.tags.includes("disableSkill"),
          )
        ) {
          this.log(
            DetailLogType.Other,
            `Skill [skill:${
              arg.requestingSkillId
            }] (requested by ${stringifyState(
              arg.via.caller,
            )}) is requested, but current active character ${stringifyState(
              activeCh,
            )} is marked as skill-disabled`,
          );
          continue;
        }
        const skillDef = activeCh.definition.initiativeSkills.find(
          (sk) => sk.id === arg.requestingSkillId,
        );
        if (!skillDef) {
          this.log(
            DetailLogType.Other,
            `Skill [skill:${
              arg.requestingSkillId
            }] (requested by ${stringifyState(
              arg.via.caller,
            )}) is not available on current active character ${stringifyState(
              activeCh,
            )}`,
          );
          continue;
        }
        const charged = skillDef.skillType === "normal" && player.canCharged;
        const plunging =
          skillDef.skillType === "normal" &&
          (player.canPlunging ||
            activeCh.entities.some((et) =>
              et.definition.tags.includes("normalAsPlunging"),
            ));
        const skillInfo: SkillInfo = {
          caller: activeCh,
          definition: skillDef,
          fromCard: null,
          requestBy: arg.via,
          charged,
          plunging,
        };
        await this.finalizeSkill(skillInfo, { targets: [] });
        await this.handleEvent([
          "onUseSkill",
          new UseSkillEventArg(this.state, callerArea, skillInfo),
        ]);
      } else if (name === "requestDisposeCard") {
        // Execute card's onDispose handler
        const cardDef = arg.card.definition;
        const disposeDef = cardDef.onDispose;
        if (disposeDef) {
          using l = this.subLog(
            DetailLogType.Skill,
            `Execute onDispose of [card:${cardDef.id}]`,
          );
          const player = this.state.players[arg.who];
          const activeCh = player.characters[getActiveCharacterIndex(player)];
          const skillInfo: SkillInfo = {
            caller: activeCh,
            definition: disposeDef,
            fromCard: arg.card,
            requestBy: null,
            charged: false,
            plunging: false,
          };
          await this.finalizeSkill(skillInfo, { targets: [] });
        }
      } else if (name === "requestTriggerEndPhaseSkill") {
        using l = this.subLog(
          DetailLogType.Event,
          `Triggering end phase skills of ${arg.requestedEntity}`,
        );
        for (const skill of arg.requestedEntity.definition.skills) {
          if (skill.triggerOn !== "onEndPhase") {
            continue;
          }
          const skillInfo: SkillInfo = {
            caller: arg.requestedEntity,
            definition: skill,
            fromCard: null,
            requestBy: arg.via,
            charged: false,
            plunging: false,
          };
          const eventArg = new EventArg(this.state);
          await this.finalizeSkill(skillInfo, eventArg);
        }
      } else {
        using l = this.subLog(
          DetailLogType.Event,
          `Handling event ${name} (${arg.toString()}):`,
        );
        for (const { caller, skill } of allSkills(this.state, name)) {
          const skillInfo: Writable<SkillInfo> = {
            caller,
            definition: skill,
            fromCard: null,
            requestBy: null,
            charged: false,
            plunging: false,
          };
          const currentEntities = allEntities(this.state);
          // 对于弃置事件，额外地使被弃置的实体本身也能响应（但是调整技能调用者为当前玩家出战角色）
          if (name === "onDispose" && arg.entity.id === caller.id) {
            const who = getEntityArea(arg._state, arg.entity.id).who;
            skillInfo.caller = getEntityById(
              this.state,
              this.state.players[who].activeCharacterId,
              true,
            );
          } else if (!currentEntities.find((et) => et.id === caller.id)) {
            continue;
          }
          if (!(0, skill.filter)(this.state, skillInfo, arg)) {
            continue;
          }
          arg._currentSkillInfo = skillInfo;
          await this.finalizeSkill(skillInfo, arg);
        }
      }
    }
  }

  getState() {
    return this.state;
  }

  static async executeSkill(
    game: IoAndState,
    skill: SkillInfo,
    arg: GeneralSkillArg,
  ) {
    const executor = new SkillExecutor(game.state, game);
    await executor.finalizeSkill(skill, arg);
    return executor.state;
  }
  static async previewSkill(
    state: GameState,
    skill: SkillInfo,
    arg: GeneralSkillArg,
  ): Promise<PreviewResult> {
    const executor = new SkillExecutor(state);
    try {
      await executor.finalizeSkill(skill, arg);
    } catch (e) {
      if (e instanceof GiTcgIoNotProvideError) {
        return [executor.state, false];
      } else {
        throw e;
      }
    }
    return [executor.state, true];
  }
  static async handleEvent(game: IoAndState, ...event: EventAndRequest) {
    return SkillExecutor.handleEvents(game, [event]);
  }
  static async previewEvent(
    state: GameState,
    ...event: EventAndRequest
  ): Promise<PreviewResult> {
    const executor = new SkillExecutor(state);
    try {
      await executor.handleEvent(event);
    } catch (e) {
      if (e instanceof GiTcgIoNotProvideError) {
        return [executor.state, false];
      } else {
        throw e;
      }
    }
    return [executor.state, true];
  }
  static async handleEvents(game: IoAndState, events: EventAndRequest[]) {
    const executor = new SkillExecutor(game.state, game);
    await executor.handleEvent(...events);
    return executor.state;
  }
}
