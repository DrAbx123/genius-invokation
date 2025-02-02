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

import { DamageType, DiceType } from "@gi-tcg/typings";
import {
  CommonSkillType,
  SkillDescription,
  SkillType,
  EventNames,
  SkillInfo,
  TriggeredSkillDefinition,
  SkillActionFilter,
  PlayCardInfo,
  SwitchActiveInfo,
  UseSkillInfo,
  EventArgOf,
  ModifyAction0EventArg,
  ModifyAction1EventArg,
  ModifyAction2EventArg,
  ModifyAction3EventArg,
  ActionEventArg,
  DamageInfo,
  SkillResult,
  ElementalTuningInfo,
  InitiativeSkillDefinition,
  InitiativeSkillEventArg,
  InitiativeSkillFilter,
  InitiativeSkillTargetGetter,
} from "../base/skill";
import { AnyState, EntityVariables, GameState } from "../base/state";
import { ContextMetaBase, SkillContext, TypedSkillContext } from "./context";
import { ExtensionHandle, SkillHandle } from "./type";
import {
  EntityArea,
  USAGE_PER_ROUND_VARIABLE_NAMES,
  UsagePerRoundVariableNames,
} from "../base/entity";
import { EntityBuilder, EntityBuilderResultT, VariableOptions } from "./entity";
import { getEntityArea, isCharacterInitiativeSkill } from "../utils";
import { GiTcgCoreInternalError, GiTcgDataError } from "../error";
import { DEFAULT_VERSION_INFO, Version, VersionInfo } from "../base/version";
import { createVariable } from "./utils";
import { registerInitiativeSkill } from "./registry";
import { InitiativeSkillTargetKind } from "../base/card";
import {
  StrictInitiativeSkillEventArg,
  TargetKindOfQuery,
  TargetQuery,
} from "./card";

export type BuilderMetaBase = Omit<ContextMetaBase, "readonly">;
export type ReadonlyMetaOf<BM extends BuilderMetaBase> = {
  [K in keyof BuilderMetaBase]: BM[K];
} & { readonly: true };
export type WritableMetaOf<BM extends BuilderMetaBase> = {
  [K in keyof BuilderMetaBase]: BM[K];
} & { readonly: false };

export type SkillOperation<Meta extends BuilderMetaBase> = (
  c: TypedSkillContext<WritableMetaOf<Meta>>,
  e: Omit<Meta["eventArgType"], `_${string}`>,
) => void;

export type SkillOperationFilter<Meta extends BuilderMetaBase> = (
  c: TypedSkillContext<ReadonlyMetaOf<Meta>>,
  e: Omit<Meta["eventArgType"], `_${string}`>,
) => unknown;

enum ListenTo {
  Myself,
  SameArea,
  SamePlayer,
  All,
}

interface RelativeArg {
  callerId: number;
  callerArea: EntityArea;
  listenTo: ListenTo;
}

function checkRelative(
  state: GameState,
  entityIdOrArea: number | { who: 0 | 1 } | EntityArea,
  r: RelativeArg,
): boolean {
  let entityArea: EntityArea;
  if (typeof entityIdOrArea !== "number" && !("type" in entityIdOrArea)) {
    if (r.listenTo === ListenTo.All) {
      return true;
    } else {
      return r.callerArea.who === entityIdOrArea.who;
    }
  }
  if (typeof entityIdOrArea === "number") {
    entityArea = getEntityArea(state, entityIdOrArea);
  } else {
    entityArea = entityIdOrArea;
  }
  switch (r.listenTo) {
    case ListenTo.Myself:
      return r.callerId === entityIdOrArea;
    // @ts-expect-error fallthrough
    case ListenTo.SameArea:
      if (r.callerArea.type === "characters") {
        return (
          entityArea.type === "characters" &&
          r.callerArea.characterId === entityArea.characterId
        );
      }
    case ListenTo.SamePlayer:
      return r.callerArea.who === entityArea.who;
    case ListenTo.All:
      return true;
    default:
      const _: never = r.listenTo;
      throw new GiTcgDataError(`Unknown listenTo: ${_}`);
  }
}

type Descriptor<E extends EventNames> = readonly [
  E,
  (
    c: TypedSkillContext<
      Omit<ContextMetaBase, "eventArgType"> & { eventArgType: EventArgOf<E> }
    >,
    e: EventArgOf<E>,
    listen: RelativeArg,
  ) => boolean,
];

function defineDescriptor<E extends EventNames>(
  name: E,
  filter?: Descriptor<E>[1],
): Descriptor<E> {
  return [name, filter ?? ((e) => true)];
}

/**
 * 检查此技能使用是否适用于通常意义上的“使用技能后”。
 *
 * 通常意义上的使用技能后是指：
 * 1. 该技能为主动技能；且
 * 2. 该技能不是准备技能触发的。
 * 3. Note: 通过使用卡牌（天赋等）触发的技能也适用。
 *
 * @param allowTechnique 是否允许特技
 */
export function commonInitiativeSkillCheck(
  skillInfo: SkillInfo,
  allowTechnique = false,
): boolean {
  return (
    isCharacterInitiativeSkill(skillInfo.definition, allowTechnique) &&
    !skillInfo.definition.prepared
  );
}

function isDebuff(state: GameState, damageInfo: DamageInfo): boolean {
  return (
    getEntityArea(state, damageInfo.source.id).who ===
    getEntityArea(state, damageInfo.target.id).who
  );
}

/**
 * 定义数据描述中的触发事件名。
 *
 * 系统内部的事件名数量较少，
 * 提供给数据描述的事件名可解释为内部事件+筛选条件。
 * 比如 `onDamaged` 可解释为 `onDamage` 发生且伤害目标
 * 在监听范围内。
 */
const detailedEventDictionary = {
  roll: defineDescriptor("modifyRoll", (c, { who }, r) => {
    return checkRelative(c.state, { who }, r);
  }),
  addDice: defineDescriptor("modifyAction0", (c, { who }, r) => {
    return checkRelative(c.state, { who }, r);
  }),
  deductElementDice: defineDescriptor("modifyAction1", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r);
  }),
  deductOmniDice: defineDescriptor("modifyAction2", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r) && e.canDeductCost();
  }),
  deductOmniDiceSwitch: defineDescriptor("modifyAction2", (c, e, r) => {
    return (
      checkRelative(c.state, { who: e.who }, r) &&
      e.isSwitchActive() &&
      e.canDeductCost()
    );
  }),
  deductOmniDiceCard: defineDescriptor("modifyAction2", (c, e, r) => {
    return (
      checkRelative(c.state, { who: e.who }, r) &&
      e.isPlayCard() &&
      e.canDeductCost()
    );
  }),
  deductAllDiceCard: defineDescriptor("modifyAction3", (c, e, r) => {
    return (
      checkRelative(c.state, { who: e.who }, r) &&
      e.isPlayCard() &&
      e.canDeductCost()
    );
  }),
  deductVoidDiceSkill: defineDescriptor("modifyAction0", (c, e, r) => {
    return (
      e.isUseSkill() &&
      checkRelative(c.state, e.action.skill.caller.id, r) &&
      e.canDeductVoidCost()
    );
  }),
  deductElementDiceSkill: defineDescriptor("modifyAction1", (c, e, r) => {
    return (
      e.isUseSkill() && checkRelative(c.state, e.action.skill.caller.id, r)
    );
  }),
  deductOmniDiceSkill: defineDescriptor("modifyAction2", (c, e, r) => {
    return (
      e.isUseSkill() &&
      checkRelative(c.state, e.action.skill.caller.id, r) &&
      e.canDeductCost()
    );
  }),
  modifyAction: defineDescriptor("modifyAction2", (c, { who }, r) => {
    return checkRelative(c.state, { who }, r);
  }),
  beforeFastSwitch: defineDescriptor("modifyAction2", (c, e, r) => {
    return (
      checkRelative(c.state, { who: e.who }, r) &&
      e.isSwitchActive() &&
      !e.isFast()
    );
  }),
  modifyDamageType: defineDescriptor("modifyDamage0", (c, e, r) => {
    return checkRelative(c.state, e.source.id, r);
  }),
  modifySkillDamageType: defineDescriptor("modifyDamage0", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing &&
      checkRelative(c.state, e.source.id, r) &&
      isCharacterInitiativeSkill(e.via.definition) &&
      e.damageInfo.fromReaction === null
    );
  }),
  increaseDamage: defineDescriptor("modifyDamage1", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing &&
      checkRelative(c.state, e.source.id, r) &&
      !isDebuff(c.state, e.damageInfo)
    );
  }),
  increaseSkillDamage: defineDescriptor("modifyDamage1", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing &&
      checkRelative(c.state, e.source.id, r) &&
      isCharacterInitiativeSkill(e.via.definition) &&
      e.damageInfo.fromReaction === null
    );
  }),
  multiplySkillDamage: defineDescriptor("modifyDamage2", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing &&
      checkRelative(c.state, e.source.id, r) &&
      isCharacterInitiativeSkill(e.via.definition) &&
      !isDebuff(c.state, e.damageInfo)
    );
  }),
  increaseDamaged: defineDescriptor("modifyDamage1", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing && checkRelative(c.state, e.target.id, r)
    );
  }),
  multiplyDamaged: defineDescriptor("modifyDamage2", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing && checkRelative(c.state, e.target.id, r)
    );
  }),
  decreaseDamaged: defineDescriptor("modifyDamage3", (c, e, r) => {
    return (
      e.type !== DamageType.Piercing && checkRelative(c.state, e.target.id, r)
    );
  }),
  beforeHealed: defineDescriptor("modifyHeal", (c, e, r) => {
    return checkRelative(c.state, e.target.id, r);
  }),
  beforeDefeated: defineDescriptor("modifyZeroHealth", (c, e, r) => {
    return checkRelative(c.state, e.target.id, r) && e._immuneInfo === null;
  }),

  battleBegin: defineDescriptor("onBattleBegin"),
  roundBegin: defineDescriptor("onRoundBegin"),
  actionPhase: defineDescriptor("onActionPhase"),
  endPhase: defineDescriptor("onEndPhase"),
  beforeAction: defineDescriptor("onBeforeAction", (c, { who }, r) => {
    return checkRelative(c.state, { who }, r);
  }),
  replaceAction: defineDescriptor("replaceAction"),
  action: defineDescriptor("onAction", (c, { who }, r) => {
    return checkRelative(c.state, { who }, r);
  }),
  playCard: defineDescriptor("onPlayCard", (c, e, r) => {
    // 支援牌不触发自身
    return c.self.id !== e.card.id && checkRelative(c.state, { who: e.who }, r);
  }),
  // modifySkill: defineDescriptor("modifyUseSkill", (c, e, r) => {
  //   return (
  //     checkRelative(c.state, e.callerArea, r) &&
  //     commonInitiativeSkillCheck(e.skill)
  //   );
  // }),
  useSkill: defineDescriptor("onUseSkill", (c, e, r) => {
    return (
      checkRelative(c.state, e.callerArea, r) &&
      commonInitiativeSkillCheck(e.skill)
    );
  }),
  useSkillOrTechnique: defineDescriptor("onUseSkill", (c, e, r) => {
    return (
      checkRelative(c.state, e.callerArea, r) &&
      commonInitiativeSkillCheck(e.skill, true)
    );
  }),
  declareEnd: defineDescriptor("onAction", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r) && e.isDeclareEnd();
  }),
  switchActive: defineDescriptor("onSwitchActive", (c, e, r) => {
    return (
      checkRelative(c.state, e.switchInfo.from.id, r) ||
      checkRelative(c.state, e.switchInfo.to.id, r)
    );
  }),
  drawCard: defineDescriptor("onDrawCard", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r);
  }),
  disposeCard: defineDescriptor("onDisposeOrTuneCard", (c, e, r) => {
    return (
      e.method !== "elementalTuning" &&
      checkRelative(c.state, { who: e.who }, r)
    );
  }),
  disposeOrTuneCard: defineDescriptor("onDisposeOrTuneCard", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r);
  }),
  dealDamage: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return e.isDamageTypeDamage() && checkRelative(c.state, e.source.id, r);
  }),
  skillDamage: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return e.isDamageTypeDamage() && checkRelative(c.state, e.source.id, r);
  }),
  damaged: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return e.isDamageTypeDamage() && checkRelative(c.state, e.target.id, r);
  }),
  healed: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return e.isDamageTypeHeal() && checkRelative(c.state, e.target.id, r);
  }),
  damagedOrHealed: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return checkRelative(c.state, e.target.id, r);
  }),
  reaction: defineDescriptor("onReaction", (c, e, r) => {
    return checkRelative(c.state, e.reactionInfo.target.id, r);
  }),
  skillReaction: defineDescriptor("onReaction", (c, e, r) => {
    return (
      checkRelative(c.state, e.caller.id, r) && e.viaCommonInitiativeSkill()
    );
  }),
  enter: defineDescriptor("onEnter", (c, e, r) => {
    return e.entity.id === r.callerId;
  }),
  enterRelative: defineDescriptor("onEnter", (c, e, r) => {
    return checkRelative(c.state, e.entity.id, r);
  }),
  dispose: defineDescriptor("onDispose", (c, e, r) => {
    return checkRelative(e._state, e.entity.id, r);
  }),
  selfDispose: defineDescriptor("onDispose", (c, e, r) => {
    // 由于此时场上不再存在 self，故只能通过 skillDefinition 是否位于 entity 的定义内来判断
    return e.entity.definition.skills.some(
      (sk) => sk.id === c.skillInfo.definition.id,
    );
  }),
  defeated: defineDescriptor("onDamageOrHeal", (c, e, r) => {
    return checkRelative(c.state, e.target.id, r) && e.damageInfo.causeDefeated;
  }),
  revive: defineDescriptor("onRevive", (c, e, r) => {
    return checkRelative(c.state, e.character.id, r);
  }),
  transformDefinition: defineDescriptor("onTransformDefinition", (c, e, r) => {
    return checkRelative(c.state, e.entity.id, r);
  }),
  generateDice: defineDescriptor("onGenerateDice", (c, e, r) => {
    return checkRelative(c.state, { who: e.who }, r);
  }),
} satisfies Record<string, Descriptor<any>>;

type OverrideEventArgType = {
  deductOmniDiceSwitch: ModifyAction2EventArg<SwitchActiveInfo>;
  deductOmniDiceCard: ModifyAction2EventArg<PlayCardInfo>;
  beforeFastSwitch: ModifyAction2EventArg<SwitchActiveInfo>;
  deductAllDiceCard: ModifyAction3EventArg<PlayCardInfo>;
  deductVoidDiceSkill: ModifyAction0EventArg<UseSkillInfo>;
  deductElementDiceSkill: ModifyAction1EventArg<UseSkillInfo>;
  deductOmniDiceSkill: ModifyAction2EventArg<UseSkillInfo>;
};

type DetailedEventDictionary = typeof detailedEventDictionary;
export type DetailedEventNames = keyof DetailedEventDictionary;
export type DetailedEventArgOf<E extends DetailedEventNames> =
  E extends keyof OverrideEventArgType
    ? OverrideEventArgType[E]
    : EventArgOf<DetailedEventDictionary[E][0]>;

export type SkillInfoGetter = () => SkillInfo;

const BUILDER_META_TYPE: unique symbol = Symbol();

export abstract class SkillBuilder<Meta extends BuilderMetaBase> {
  declare [BUILDER_META_TYPE]: Meta;

  protected operations: SkillOperation<Meta>[] = [];
  protected filters: SkillOperationFilter<Meta>[] = [];
  protected associatedExtensionId: number | undefined = void 0;
  constructor(protected readonly id: number) {}
  private applyIfFilter = false;
  private _ifFilter: SkillOperationFilter<Meta> = () => true;

  protected _wrapSkillInfoWithExt(skillInfo: SkillInfo): SkillInfo {
    return { ...skillInfo, associatedExtensionId: this.associatedExtensionId };
  }

  if(filter: SkillOperationFilter<Meta>): this {
    this._ifFilter = filter;
    this.applyIfFilter = true;
    return this;
  }

  do(op: SkillOperation<Meta>): this {
    if (this.applyIfFilter) {
      const ifFilter = this._ifFilter;
      this.operations.push((c, e) => {
        if (!ifFilter(c as any, e)) return;
        return op(c, e);
      });
    } else {
      this.operations.push(op);
    }
    this.applyIfFilter = false;
    return this;
  }

  else(): this {
    const ifFilter = this._ifFilter;
    this._ifFilter = (c, e) => !ifFilter(c, e);
    this.applyIfFilter = true;
    return this;
  }

  /**
   * 在 `state` 上，以 `skillInfo` `arg` 应用技能描述
   *
   * @returns 即 `SkillDescription` 的返回值
   */
  protected buildAction<Arg = Meta["eventArgType"]>(): SkillDescription<Arg> {
    return (state: GameState, skillInfo: SkillInfo, arg: Arg): SkillResult => {
      const ctx = new SkillContext<WritableMetaOf<Meta>>(
        state,
        this._wrapSkillInfoWithExt(skillInfo),
        arg,
      );
      for (const op of this.operations) {
        op(ctx, ctx.eventArg);
      }
      ctx._terminate();
      return [ctx.state, ctx.events] as const;
    };
  }

  protected buildFilter<Arg = Meta["eventArgType"]>(): SkillActionFilter<Arg> {
    return (state: GameState, skillInfo: SkillInfo, arg: Arg) => {
      const ctx = new SkillContext<ReadonlyMetaOf<Meta>>(
        state,
        this._wrapSkillInfoWithExt(skillInfo),
        arg,
      );
      for (const filter of this.filters) {
        if (!filter(ctx as any, ctx.eventArg)) {
          return false;
        }
      }
      return true;
    };
  }
}

// 找到所有返回 void 的方法
type AvailablePropImpl<
  Obj extends object,
  K extends keyof Obj,
> = Obj[K] extends (...args: any[]) => void
  ? ReturnType<Obj[K]> extends void
    ? K
    : never
  : never;
type AvailablePropOf<Ctx extends object> = {
  [K in keyof Ctx]: AvailablePropImpl<Ctx, K>;
}[keyof Ctx];

type SkillContextShortCutSource<Meta extends ContextMetaBase> =
  TypedSkillContext<Omit<Meta, "readonly"> & { readonly: false }> &
    Omit<Meta["eventArgType"], `_${string}`>;

type SkillContextShortcutProps<Meta extends ContextMetaBase> = AvailablePropOf<
  SkillContextShortCutSource<Meta>
>;

// 所有返回 void 的方法的参数类型
type SkillContextShortcutArgs<
  Meta extends ContextMetaBase,
  K extends keyof SkillContextShortCutSource<Meta>,
> = SkillContextShortCutSource<Meta>[K] extends (...args: infer Args) => void
  ? Args
  : never;

// 带有直达方法的 Builder，使用 `enableShortcut` 生成
export type BuilderWithShortcut<Original> = Original & {
  [K in SkillContextShortcutProps<WritableMetaOf<ExtractBM<Original>>>]: (
    ...args: SkillContextShortcutArgs<WritableMetaOf<ExtractBM<Original>>, K>
  ) => BuilderWithShortcut<Original>;
};

type ExtractBM<T> = T extends {
  [BUILDER_META_TYPE]: infer Meta extends BuilderMetaBase;
}
  ? Meta
  : never;

/**
 * 为 Builder 添加直达 SkillContext 的函数，即可
 * `.do((c) => c.PROP(ARGS))`
 * 直接简写为
 * `.PROP(ARGS)`
 */
export function enableShortcut<T extends SkillBuilder<any>>(
  original: T,
): BuilderWithShortcut<T> {
  const proxy = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      } else if (prop in SkillContext.prototype) {
        return function (this: T, ...args: any[]) {
          return this.do((c) => (c as any)[prop](...args));
        };
      } else {
        return function (this: T, ...args: any[]) {
          return this.do((c) => c.eventArg[prop](...args));
        };
      }
    },
  });
  return proxy as any;
}

export interface UsageOptions<Name extends string> extends VariableOptions {
  name?: Name;
  /** 是否为“每回合使用次数”。默认值为 `false`。 */
  perRound?: boolean;
  /** 是否在每次技能执行完毕后自动 -1。默认值为 `true`。 */
  autoDecrease?: boolean;
  /** 是否在扣除到 0 后自动弃置实体，默认值为 `true` */
  autoDispose?: boolean;
}

export class TriggeredSkillBuilder<
  Meta extends BuilderMetaBase,
  EventName extends DetailedEventNames,
> extends SkillBuilder<Meta> {
  constructor(
    id: number,
    private readonly triggerOn: EventName,
    private readonly parent: EntityBuilder<
      Meta["callerType"],
      Meta["callerVars"],
      Meta["associatedExtension"]
    >,
    triggerFilter: SkillOperationFilter<Meta> = () => true,
  ) {
    super(id);
    this.associatedExtensionId = this.parent._associatedExtensionId;
    const [, filterDescriptor] = detailedEventDictionary[this.triggerOn];
    this.filters.push((c, e) => {
      const { area, state } = c.self;
      return filterDescriptor(c as any, e as any, {
        callerArea: area,
        callerId: state.id,
        listenTo: this._listenTo,
      });
    });
    this.filters.push(triggerFilter);
  }
  private _usageOpt: { name: string; autoDecrease: boolean } | null = null;
  private _usagePerRoundOpt: {
    name: UsagePerRoundVariableNames;
    autoDecrease: boolean;
  } | null = null;
  private _listenTo: ListenTo = ListenTo.SameArea;

  /**
   * 为实体创建名为 `usage` 的变量，表示剩余使用次数。
   * 在每次技能执行完毕后，若该变量计数达到 0，则不会触发操作。
   *
   * 若 `autoDispose` 且非 `perRound`（默认），则同时会弃置实体。
   * @param count
   * @param opt @see UsageOptions
   * @returns
   */
  usage<VarName extends string = "usage">(
    count: number,
    opt?: UsageOptions<VarName>,
  ): BuilderWithShortcut<
    TriggeredSkillBuilder<
      {
        callerType: Meta["callerType"];
        callerVars: Meta["callerVars"] | VarName;
        eventArgType: Meta["eventArgType"];
        associatedExtension: Meta["associatedExtension"];
      },
      EventName
    >
  > {
    const perRound = opt?.perRound ?? false;
    const autoDecrease = opt?.autoDecrease ?? true;
    const name = this.parent._setUsage(count, opt);
    if (perRound) {
      if (this._usagePerRoundOpt !== null) {
        throw new GiTcgDataError("Cannot specify usagePerRound twice.");
      }
      this._usagePerRoundOpt = { name: name as any, autoDecrease };
    } else {
      if (this._usageOpt !== null) {
        throw new GiTcgDataError("Cannot specify usage twice.");
      }
      this._usageOpt = { name, autoDecrease };
    }
    // 增加“检查可用次数”的技能触发条件
    this.filters.push((c) => c.self.getVariable(name) > 0);
    return this as any;
  }
  /**
   * Same as
   * ```
   *   .usage(count, { ...opt, perRound: true, visible: false })
   * ```
   */
  usagePerRound<VarName extends UsagePerRoundVariableNames = "usagePerRound">(
    count: number,
    opt?: Omit<UsageOptions<VarName>, "perRound">,
  ) {
    return this.usage<VarName>(count, {
      ...opt,
      perRound: true,
      visible: false,
    });
  }
  usageCanAppend<VarName extends string = "usage">(
    count: number,
    appendLimit?: number,
    appendValue?: number,
  ) {
    return this.usage<VarName>(count, {
      append: { limit: appendLimit, value: appendValue },
    });
  }

  listenToPlayer(): this {
    this._listenTo = ListenTo.SamePlayer;
    return this;
  }

  listenToAll(): this {
    this._listenTo = ListenTo.All;
    return this;
  }

  private buildSkill() {
    if (this._usagePerRoundOpt?.autoDecrease) {
      this.do((c) => {
        c.consumeUsagePerRound();
      });
    }
    if (this._usageOpt?.autoDecrease) {
      if (this._usageOpt.name === "usage") {
        // 若变量名为 usage，则消耗可用次数时可能调用 c.dispose
        // 使用 consumeUsage 方法实现相关操作
        this.do((c) => {
          c.consumeUsage();
        });
      } else {
        // 否则手动扣除使用次数
        const name = this._usageOpt.name;
        this.do((c) => {
          c.addVariable(name, -1);
        });
      }
    }
    const [eventName] = detailedEventDictionary[this.triggerOn];
    const def: TriggeredSkillDefinition = {
      type: "skill",
      skillType: null,
      id: this.id,
      triggerOn: eventName,
      requiredCost: [],
      gainEnergy: false,
      filter: this.buildFilter(),
      action: this.buildAction(),
      usagePerRoundVariableName: this._usagePerRoundOpt?.name ?? null,
    };
    this.parent._skillList.push(def);
  }

  endOn() {
    this.buildSkill();
    return this.parent;
  }
  on<E extends DetailedEventNames>(
    event: E,
    filter?: SkillOperationFilter<{
      eventArgType: DetailedEventArgOf<E>;
      callerType: Meta["callerType"];
      callerVars: Meta["callerVars"];
      associatedExtension: Meta["associatedExtension"];
    }>,
  ) {
    this.buildSkill();
    return this.parent.on(event, filter);
  }
  once<E extends DetailedEventNames>(
    event: E,
    filter?: SkillOperationFilter<{
      eventArgType: DetailedEventArgOf<E>;
      callerType: Meta["callerType"];
      callerVars: Meta["callerVars"];
      associatedExtension: Meta["associatedExtension"];
    }>,
  ) {
    this.buildSkill();
    return this.parent.once(event, filter);
  }

  done(): EntityBuilderResultT<Meta["callerType"]> {
    this.buildSkill();
    return this.parent.done();
  }
}

export abstract class SkillBuilderWithCost<
  Meta extends BuilderMetaBase,
> extends SkillBuilder<Meta> {
  protected _targetQueries: string[] = [];

  protected addTargetImpl(targetQuery: string) {
    this._targetQueries = [...this._targetQueries, targetQuery];
  }

  private generateTargetList(
    state: GameState,
    skillInfo: SkillInfo,
    known: AnyState[],
    targetQuery: string[],
  ): AnyState[][] {
    if (targetQuery.length === 0) {
      return [[]];
    }
    const [first, ...rest] = targetQuery;
    const ctx = new SkillContext<ReadonlyMetaOf<BuilderMetaBase>>(
      state,
      this._wrapSkillInfoWithExt(skillInfo),
      {
        targets: known,
      },
    );
    const states = ctx.$$(first).map((c) => c.state);
    return states.flatMap((st) =>
      this.generateTargetList(state, skillInfo, [...known, st], rest).map(
        (l) => [st, ...l],
      ),
    );
  }

  protected buildTargetGetter(): InitiativeSkillTargetGetter {
    return (state, skillInfo) => {
      const targetIdsList = this.generateTargetList(
        state,
        skillInfo,
        [],
        this._targetQueries,
      );
      return targetIdsList.map((targets) => ({ targets }));
    };
  }

  constructor(skillId: number) {
    super(skillId);
  }
  protected _cost: DiceType[] = [];
  private cost(type: DiceType, count: number): this {
    this._cost.push(...Array(count).fill(type));
    return this;
  }
  costVoid(count: number) {
    return this.cost(DiceType.Void, count);
  }
  costCryo(count: number) {
    return this.cost(DiceType.Cryo, count);
  }
  costHydro(count: number) {
    return this.cost(DiceType.Hydro, count);
  }
  costPyro(count: number) {
    return this.cost(DiceType.Pyro, count);
  }
  costElectro(count: number) {
    return this.cost(DiceType.Electro, count);
  }
  costAnemo(count: number) {
    return this.cost(DiceType.Anemo, count);
  }
  costGeo(count: number) {
    return this.cost(DiceType.Geo, count);
  }
  costDendro(count: number) {
    return this.cost(DiceType.Dendro, count);
  }
  costSame(count: number) {
    return this.cost(DiceType.Same, count);
  }
  costEnergy(count: number) {
    return this.cost(DiceType.Energy, count);
  }
}

class InitiativeSkillBuilder<
  AssociatedExt extends ExtensionHandle,
> extends SkillBuilderWithCost<{
  callerType: "character";
  callerVars: never;
  eventArgType: InitiativeSkillEventArg;
  associatedExtension: AssociatedExt;
}> {
  private _skillType: SkillType = "normal";
  private _gainEnergy = true;
  protected _cost: DiceType[] = [];
  private _versionInfo: VersionInfo = DEFAULT_VERSION_INFO;
  private _prepared = false;
  constructor(private readonly skillId: number) {
    super(skillId);
  }

  since(version: Version) {
    this._versionInfo = { predicate: "since", version };
    return this;
  }
  until(version: Version) {
    this._versionInfo = { predicate: "until", version };
    return this;
  }

  associateExtension<NewExtT>(ext: ExtensionHandle<NewExtT>) {
    if (typeof this.associatedExtensionId !== "undefined") {
      throw new GiTcgDataError(
        `This skill has already associated with extension ${this.id}`,
      );
    }
    this.associatedExtensionId = ext;
    return this as unknown as InitiativeSkillBuilder<ExtensionHandle<NewExtT>>;
  }

  prepared(): this {
    this._prepared = true;
    return this.noEnergy();
  }
  noEnergy(): this {
    this._gainEnergy = false;
    return this;
  }

  type(type: "passive"): EntityBuilder<"character">;
  type(type: CommonSkillType): this;
  type(type: CommonSkillType | "passive"): any {
    if (type === "passive") {
      const builder = new EntityBuilder("character", this.skillId);
      builder._versionInfo = this._versionInfo;
      return builder;
    }
    if (type === "burst" || type === "technique") {
      this._gainEnergy = false;
    }
    this._skillType = type;
    return this;
  }

  /** 此定义未被使用。 */
  reserve(): void {}

  done(): SkillHandle {
    registerInitiativeSkill({
      __definition: "initiativeSkills",
      type: "initiativeSkill",
      version: this._versionInfo,
      id: this.skillId,
      skill: {
        type: "skill",
        skillType: this._skillType,
        id: this.skillId,
        triggerOn: null,
        requiredCost: this._cost,
        gainEnergy: this._gainEnergy,
        prepared: this._prepared,
        action: this.buildAction(),
        filter: this.buildFilter(),
        getTarget: this.buildTargetGetter(),
        usagePerRoundVariableName: null,
      },
    });
    return this.skillId as SkillHandle;
  }
}

export class TechniqueBuilder<
  Vars extends string,
  KindTs extends InitiativeSkillTargetKind,
  AssociatedExt extends ExtensionHandle,
> extends SkillBuilderWithCost<{
  callerType: "equipment";
  callerVars: Vars;
  eventArgType: StrictInitiativeSkillEventArg<KindTs>;
  associatedExtension: AssociatedExt;
}> {
  private _usageOpt: { name: string; autoDecrease: boolean } | null = null;
  private _usagePerRoundOpt: {
    name: UsagePerRoundVariableNames;
    autoDecrease: boolean;
  } | null = null;

  constructor(
    id: number,
    private readonly parent: EntityBuilder<"equipment", Vars, AssociatedExt>,
  ) {
    super(id);
    this.associatedExtensionId = this.parent._associatedExtensionId;
  }

  addTarget<Q extends TargetQuery>(
    targetQuery: Q,
  ): BuilderWithShortcut<
    TechniqueBuilder<
      Vars,
      readonly [...KindTs, TargetKindOfQuery<Q>],
      AssociatedExt
    >
  > {
    this.addTargetImpl(targetQuery);
    return this as any;
  }

  usage<VarName extends string = "usage">(
    count: number,
    opt?: UsageOptions<VarName>,
  ): BuilderWithShortcut<
    TechniqueBuilder<Vars | VarName, KindTs, AssociatedExt>
  > {
    const perRound = opt?.perRound ?? false;
    const autoDecrease = opt?.autoDecrease ?? true;
    const name = this.parent._setUsage(count, opt);
    if (perRound) {
      if (this._usagePerRoundOpt !== null) {
        throw new GiTcgDataError("Cannot specify usagePerRound twice.");
      }
      this._usagePerRoundOpt = { name: name as any, autoDecrease };
    } else {
      if (this._usageOpt !== null) {
        throw new GiTcgDataError("Cannot specify usage twice.");
      }
      this._usageOpt = { name, autoDecrease };
    }
    // 增加“检查可用次数”的技能触发条件
    this.filters.push((c) => c.self.getVariable(name) > 0);
    return this as any;
  }
  usagePerRound<VarName extends UsagePerRoundVariableNames = "usagePerRound">(
    count: number,
    opt?: Omit<UsageOptions<VarName>, "perRound">,
  ) {
    return this.usage<VarName>(count, {
      ...opt,
      perRound: true,
      visible: false,
    });
  }

  private buildSkill() {
    if (this._usagePerRoundOpt?.autoDecrease) {
      this.do((c) => {
        c.consumeUsagePerRound();
      });
    }
    if (this._usageOpt?.autoDecrease) {
      if (this._usageOpt.name === "usage") {
        // 若变量名为 usage，则消耗可用次数时可能调用 c.dispose
        // 使用 consumeUsage 方法实现相关操作
        this.do((c) => {
          c.consumeUsage();
        });
      } else {
        // 否则手动扣除使用次数
        const name = this._usageOpt.name;
        this.do((c) => {
          c.self.addVariable(name, -1);
        });
      }
    }
    const def: InitiativeSkillDefinition = {
      type: "skill",
      skillType: "technique",
      triggerOn: null,
      id: this.id,
      requiredCost: this._cost,
      gainEnergy: false,
      prepared: false,
      filter: this.buildFilter(),
      action: this.buildAction(),
      getTarget: this.buildTargetGetter(),
      usagePerRoundVariableName: this._usagePerRoundOpt?.name ?? null,
    };
    this.parent._initiativeSkills.push(def);
  }

  endProvide() {
    this.buildSkill();
    return this.parent;
  }

  done() {
    this.buildSkill();
    return this.parent.done();
  }
}

export function skill(id: number) {
  return enableShortcut(new InitiativeSkillBuilder(id));
}
