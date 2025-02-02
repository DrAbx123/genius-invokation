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

import { DamageType } from "@gi-tcg/typings";
import {
  DescriptionDictionary,
  DescriptionDictionaryEntry,
  DescriptionDictionaryKey,
  EntityArea,
  EntityTag,
  EntityVariableConfigs,
  ExEntityType,
  USAGE_PER_ROUND_VARIABLE_NAMES,
  VariableConfig,
} from "../base/entity";
import { InitiativeSkillDefinition, TriggeredSkillDefinition } from "../base/skill";
import { registerEntity, registerPassiveSkill } from "./registry";
import {
  BuilderWithShortcut,
  DetailedEventArgOf,
  DetailedEventNames,
  SkillOperationFilter,
  TechniqueBuilder,
  TriggeredSkillBuilder,
  UsageOptions,
  enableShortcut,
} from "./skill";
import {
  ExtensionHandle,
  HandleT,
  PassiveSkillHandle,
  SkillHandle,
} from "./type";
import { GiTcgCoreInternalError, GiTcgDataError } from "../error";
import { createVariable, createVariableCanAppend } from "./utils";
import { Writable, getEntityArea, getEntityById } from "../utils";
import { EntityState, GameState } from "../base/state";
import { Version, VersionInfo, DEFAULT_VERSION_INFO } from "../base/version";

export interface AppendOptions {
  /** 重复创建时的累积值上限 */
  limit?: number;
  /** 重复创建时累积的值 */
  value?: number;
}

export interface VariableOptions {
  /** 该值在重复创建时是否允许叠加。 */
  append?: AppendOptions | boolean;
  /**
   * 该值在重复创建时将强制重置为默认值（而非默认值和当前值的最大值）。
   * 指定 `append` 时此选项无效。
   */
  forceOverwrite?: boolean;
  /** 该值是否在前端可见，默认为 `true`。仅最后一次添加的变量会显示。 */
  visible?: boolean;
}

export type VariableOptionsWithoutAppend = Omit<VariableOptions, "append">;

// 当 CallerType 是 character 时，正在构建的是被动技能，返回 PassiveSkillHandle
export type EntityBuilderResultT<CallerType extends ExEntityType> =
  CallerType extends "character" ? PassiveSkillHandle : HandleT<CallerType>;

type BuilderMetaOfEntity<
  Event extends DetailedEventNames,
  CallerType extends ExEntityType,
  Vars extends string,
  AssociatedExt extends ExtensionHandle,
> = {
  callerType: CallerType;
  callerVars: Vars;
  eventArgType: DetailedEventArgOf<Event>;
  associatedExtension: AssociatedExt;
};

interface GlobalUsageOptions extends VariableOptions {
  /**
   * 是否在 consumeUsage() 且变量到达 0 时时自动弃置实体。
   * 默认为 true
   */
  autoDispose?: boolean;
}

type EntityStateWithArea = EntityState & { readonly area: EntityArea };

type EntityDescriptionDictionaryGetter<AssociatedExt extends ExtensionHandle> =
  (
    st: GameState,
    self: EntityStateWithArea,
    ext: AssociatedExt["type"],
  ) => string | number;

export class EntityBuilder<
  CallerType extends ExEntityType,
  Vars extends string = never,
  AssociatedExt extends ExtensionHandle = never,
> {
  private _skillNo = 0;
  _skillList: TriggeredSkillDefinition[] = [];
  _usagePerRoundIndex = 0;
  private _tags: EntityTag[] = [];
  _varConfigs: Writable<EntityVariableConfigs> = {};
  private _visibleVarName: string | null = null;
  _associatedExtensionId: number | undefined = void 0;
  private _hintText: string | null = null;
  private _descriptionDictionary: Writable<DescriptionDictionary> = {};
  _versionInfo: VersionInfo = DEFAULT_VERSION_INFO;
  _initiativeSkills: InitiativeSkillDefinition[] = [];
  private generateSkillId() {
    const thisSkillNo = ++this._skillNo;
    return this.id + thisSkillNo / 100;
  }

  constructor(
    public _type: CallerType,
    private id: number,
  ) {}

  since(version: Version) {
    this._versionInfo = { predicate: "since", version };
    return this;
  }
  until(version: Version) {
    this._versionInfo = { predicate: "until", version };
    return this;
  }

  replaceDescription(
    key: DescriptionDictionaryKey,
    getter: EntityDescriptionDictionaryGetter<AssociatedExt>,
  ) {
    if (Reflect.has(this._descriptionDictionary, key)) {
      throw new GiTcgDataError(`Description key ${key} already exists`);
    }
    const entry: DescriptionDictionaryEntry = (st, id) => {
      const self = getEntityById(st, id);
      const area = getEntityArea(st, id);
      const ext = st.extensions.find(
        (ext) => ext.definition.id === this._associatedExtensionId,
      );
      return String(getter(st, { ...self, area }, ext?.state));
    };
    this._descriptionDictionary[key] = entry;
    return this;
  }

  associateExtension<NewExtT>(ext: ExtensionHandle<NewExtT>) {
    if (typeof this._associatedExtensionId !== "undefined") {
      throw new GiTcgDataError(
        `This entity has already associated with extension ${this.id}`,
      );
    }
    this._associatedExtensionId = ext;
    return this as unknown as EntityBuilder<
      CallerType,
      Vars,
      ExtensionHandle<NewExtT>
    >;
  }

  provideSkill(id: number) {
    if (this._type !== "equipment") {
      throw new GiTcgDataError("Only equipment can have technique skill");
    }
    const self = this as unknown as EntityBuilder<"equipment", Vars, AssociatedExt>;
    return enableShortcut(new TechniqueBuilder<Vars, readonly [], AssociatedExt>(id, self));
  }

  conflictWith(id: number) {
    return this.on("enter", (c) => c.$(`my any with definition id ${id}`))
      .do((c) => {
        // 将位于相同实体区域的目标实体移除
        for (const entity of c.$$(`my any with definition id ${id}`)) {
          if (
            entity.area.type === "characters" &&
            c.self.area.type === "characters"
          ) {
            if (entity.area.characterId === c.self.area.characterId) {
              entity.dispose();
            }
          } else if (entity.area.type === c.self.area.type) {
            entity.dispose();
          }
        }
      })
      .endOn();
  }
  unique(...otherIds: number[]) {
    if (this._type !== "status") {
      throw new GiTcgDataError("Only character status can be unique");
    }
    const ids = [this.id, ...otherIds];
    const targetQuery = ids
      .map((id) => `(status with definition id ${id})`)
      .join(" or ");
    return this.on("enter").dispose(`(${targetQuery}) and not @self`).endOn();
  }

  on<E extends DetailedEventNames>(
    event: E,
    filter?: SkillOperationFilter<
      BuilderMetaOfEntity<E, CallerType, Vars, AssociatedExt>
    >,
  ) {
    // BuilderWithShortcut<
    //   TriggeredSkillBuilder<BuilderMetaOfEntity<E, CallerType, Vars>, E>
    // >
    return enableShortcut(
      new TriggeredSkillBuilder<
        BuilderMetaOfEntity<E, CallerType, Vars, AssociatedExt>,
        E
      >(this.generateSkillId(), event, this, filter),
    );
  }
  once<E extends DetailedEventNames>(
    event: E,
    filter?: SkillOperationFilter<
      BuilderMetaOfEntity<E, CallerType, Vars, AssociatedExt>
    >,
  ) {
    return this.on(event, filter).usage<never>(1, {
      visible: false,
    });
  }

  variable<const Name extends string>(
    name: Name,
    value: number,
    opt?: VariableOptions,
  ): EntityBuilder<CallerType, Vars | Name, AssociatedExt> {
    if (Reflect.has(this._varConfigs, name)) {
      throw new GiTcgDataError(`Variable name ${name} already exists`);
    }
    let appendOpt: AppendOptions | false;
    if (opt?.append) {
      if (opt.append === true) {
        appendOpt = {};
      } else {
        appendOpt = opt.append;
      }
    } else {
      appendOpt = false;
    }
    let varConfig: VariableConfig;
    if (appendOpt) {
      varConfig = createVariableCanAppend(
        value,
        appendOpt.limit,
        appendOpt.value,
      );
    } else {
      varConfig = createVariable(value, opt?.forceOverwrite);
    }
    this._varConfigs[name] = varConfig;
    const visible = opt?.visible ?? true;
    if (visible) {
      this._visibleVarName = name;
    }
    return this as any;
  }
  variableCanAppend<const Name extends string>(
    name: Name,
    value: number,
    max?: number,
    opt?: VariableOptionsWithoutAppend,
  ): EntityBuilder<CallerType, Vars | Name, AssociatedExt>;
  variableCanAppend<const Name extends string>(
    name: Name,
    value: number,
    max: number,
    appendValue: number,
    opt?: VariableOptionsWithoutAppend,
  ): EntityBuilder<CallerType, Vars | Name, AssociatedExt>;
  variableCanAppend(
    name: string,
    value: number,
    max: number,
    appendOrOpt?: number | VariableOptionsWithoutAppend,
    opt?: VariableOptionsWithoutAppend,
  ): any {
    if (typeof appendOrOpt === "number") {
      return this.variable(name, value, {
        append: { limit: max, value: appendOrOpt },
        ...opt,
      });
    } else {
      return this.variable(name, value, {
        append: { limit: max },
        ...appendOrOpt,
      });
    }
  }

  /**
   * 当 skill builder 指定 .usage 时，上层 entity builder 的操作
   * @param count 
   * @param opt 
   * @returns usage 变量名
   */
  _setUsage(count: number, opt?: UsageOptions<string>): string {
    const perRound = opt?.perRound ?? false;
    let name: string;
    if (opt?.name) {
      name = opt.name;
    } else {
      if (this._type === "character") {
        throw new GiTcgDataError(
          `You must explicitly set the name of usage when defining passive skill. Be careful that different passive skill should have distinct usage name.`,
        );
      }
      if (perRound) {
        if (
          this._usagePerRoundIndex >=
          USAGE_PER_ROUND_VARIABLE_NAMES.length
        ) {
          throw new GiTcgCoreInternalError(
            `Cannot specify more than ${USAGE_PER_ROUND_VARIABLE_NAMES.length} usagePerRound.`,
          );
        }
        name = USAGE_PER_ROUND_VARIABLE_NAMES[this._usagePerRoundIndex];
        this._usagePerRoundIndex++;
      } else {
        name = "usage";
      }
    }
    const autoDispose = name === "usage" && opt?.autoDispose !== false;
    this.variable(name, count, opt);
    if (autoDispose) {
      this._varConfigs.disposeWhenUsageIsZero = createVariable(1);
    }
    return name;
  }

  duration(count: number, opt?: VariableOptions) {
    return this.variable("duration", count, opt);
  }
  oneDuration(opt?: VariableOptions) {
    return this.duration(1, { ...opt, visible: false });
  }

  shield(count: number, max?: number) {
    this.tags("shield");
    return this.variableCanAppend("shield", count, max ?? count)
      .on("decreaseDamaged", (c, e) => {
        if (c.self.state.definition.type === "combatStatus") {
          // 出战状态护盾只对出战角色生效
          return c.of(e.target).isActive();
        } else {
          return true;
        }
      })
      .do((c, e) => {
        const shield = c.getVariable("shield");
        const currentValue = e.value;
        const decreased = Math.min(shield, currentValue);
        e.decreaseDamage(decreased);
        c.addVariable("shield", -decreased);
        if (shield <= currentValue) {
          c.dispose();
        }
      })
      .endOn();
  }

  prepare(skill: SkillHandle, hintCount?: number) {
    if (this._type !== "status") {
      throw new GiTcgDataError("Only status can have prepare skill");
    }
    if (hintCount) {
      this.variable("preparingSkillHintCount", hintCount);
    }
    return (this as unknown as EntityBuilder<"status", Vars, AssociatedExt>)
      .on("replaceAction")
      .useSkill(skill)
      .dispose()
      .on("switchActive", (c, e) => e.switchInfo.from.id === c.self.master().id)
      .dispose()
      .endOn();
  }

  tags(...tags: EntityTag[]): this {
    this._tags.push(...tags);
    return this;
  }

  hintText(text: string): this {
    this._hintText = text;
    return this;
  }
  hintIcon(damageType: DamageType) {
    return this.variable("hintIcon", damageType);
  }

  /**
   * Same as
   * ```
   *   .hintIcon(type)
   *   .hintText(`${value}`)
   *   .on("endPhase")
   *   .damage(type, value[, target])
   * ```
   *
   * Note: use `DamageType.Heal` as equivalent of `.heal`
   * @param type
   * @param value
   * @returns
   */
  endPhaseDamage(
    type: DamageType | "swirledAnemo",
    value: number,
    target?: string,
  ): BuilderWithShortcut<
    TriggeredSkillBuilder<
      BuilderMetaOfEntity<
        "endPhase",
        CallerType,
        Vars | "hintIcon",
        AssociatedExt
      >,
      "endPhase"
    >
  > {
    if (type === "swirledAnemo") {
      return this.hintIcon(DamageType.Anemo)
        .hintText(`${value}`)
        .on(
          "dealDamage",
          (c, e) =>
            ["character", "summon"].includes(e.source.definition.type) &&
            e.isSwirl() !== null,
        )
        .usage(1, { name: "swirledUsage" as never, visible: false })
        .do((c, e) => {
          const swirledType = e.isSwirl()!;
          c.setVariable("hintIcon", swirledType);
        })
        .on("endPhase")
        .do((c) => {
          c.damage(c.self.state.variables.hintIcon, value, target);
        });
    } else {
      return this.hintIcon(type)
        .hintText(`${value}`)
        .on("endPhase")
        .damage(type, value, target);
    }
  }

  usage(
    count: number,
    opt: GlobalUsageOptions = {},
  ): EntityBuilder<CallerType, Vars | "usage", AssociatedExt> {
    if (opt.autoDispose !== false) {
      this.variable("disposeWhenUsageIsZero", 1);
    }
    return this.variable("usage", count);
  }

  done(): EntityBuilderResultT<CallerType> {
    if (this._type === "status" || this._type === "equipment") {
      this.on("defeated").dispose().endOn();
    }
    // on each round begin clean up
    const usagePerRoundNames = USAGE_PER_ROUND_VARIABLE_NAMES.filter((name) =>
      Reflect.has(this._varConfigs, name),
    );
    const hasDuration = Reflect.has(this._varConfigs, "duration");
    if (usagePerRoundNames.length > 0 || hasDuration) {
      this.on("roundBegin")
        .do((c, e) => {
          const self = c.self;
          // 恢复每回合使用次数
          for (const prop of usagePerRoundNames) {
            const config = self.state.definition.varConfigs[prop];
            if (config) {
              self.setVariable(prop, config.initialValue);
            }
          }
          // 扣除持续回合数
          if (hasDuration) {
            self.addVariable("duration", -1);
            if (self.getVariable("duration")! <= 0) {
              self.dispose();
            }
          }
        })
        .endOn();
    }
    if (this._type === "character") {
      registerPassiveSkill({
        __definition: "passiveSkills",
        id: this.id,
        type: "passiveSkill",
        version: this._versionInfo,
        varConfigs: this._varConfigs,
        skills: this._skillList,
      });
    } else {
      registerEntity({
        __definition: "entities",
        id: this.id,
        version: this._versionInfo,
        visibleVarName: this._visibleVarName,
        varConfigs: this._varConfigs,
        hintText: this._hintText,
        initiativeSkills: this._initiativeSkills,
        skills: this._skillList,
        tags: this._tags,
        type: this._type,
        descriptionDictionary: this._descriptionDictionary,
      });
    }
    return this.id as EntityBuilderResultT<CallerType>;
  }

  /** 此定义未被使用。 */
  reserve(): void {}
}

export function summon(id: number) {
  return new EntityBuilder("summon", id);
}

export function status(id: number) {
  return new EntityBuilder("status", id);
}

export function combatStatus(id: number) {
  return new EntityBuilder("combatStatus", id);
}

export function equipment(id: number) {
  return new EntityBuilder("equipment", id);
}

export function support(id: number) {
  return new EntityBuilder("support", id);
}
