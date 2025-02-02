// Copyright (C) 2024 theBowja, Guyutongxue
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

import { config } from "./config";
import { readJson } from "./json";
import fs from "node:fs";
import {
  getLanguage,
  sanitizeDescription,
  sanitizeName,
  xskill,
  getDescriptionReplaced,
} from "./utils";
import { getSkillIcon } from "./skill_icon";

// Goes through binoutput to get data on tcg skill's damage and element
const tcgSkillKeyMap: Record<string, any> = {};
const filelist = fs.readdirSync(
  `${config.input}/BinOutput/GCG/Gcg_DeclaredValueSet`,
);

const PROPERTIES_KEY_MAP = {
  "-2060930438": "D__KEY__DAMAGE",
  "1428448537": "D__KEY__DAMAGE_2",
  "1428448540": "D__KEY__DAMAGE_5",
  "476224977": "D__KEY__ELEMENT",
} as Record<string, string>;

type ValueGrabber<T = any> = (obj: object) => T;

const numberGrabber: ValueGrabber<number> = (obj) =>
  Object.values(obj).find((val) => typeof val === "number")! as number;

const VALUE_GRABBER = {
  D__KEY__DAMAGE: numberGrabber,
  D__KEY__DAMAGE_2: numberGrabber,
  D__KEY__DAMAGE_5: numberGrabber,
  D__KEY__ELEMENT: (obj: object) =>
    Object.values(obj).find(
      (val) => typeof val === "string" && val.startsWith("GCG"),
    )! as string,
} as Record<string, ValueGrabber>;

for (const filename of filelist) {
  if (!filename.endsWith(".json")) continue;

  const fileObj = readJson(
    `${config.input}/BinOutput/GCG/Gcg_DeclaredValueSet/${filename}`,
  );

  try {
    const dataName = fileObj.name;
    if (`${dataName}.json` !== filename) {
      continue;
    }
    const uncutmap: any = Object.values(fileObj)[1];

    tcgSkillKeyMap[dataName] = {};

    for (let [key, kobj] of Object.entries(uncutmap) as [string, any][]) {
      if (key in PROPERTIES_KEY_MAP) {
        let value = VALUE_GRABBER[PROPERTIES_KEY_MAP[key]](kobj);
        if (typeof value === "undefined") {
          // D__KEY__ELEMENT 可空（即物理伤害）
          if (PROPERTIES_KEY_MAP[key] !== "D__KEY__ELEMENT") {
            console.log(
              `loadTcgSkillKeyMap ${dataName}.json failed to extract ${PROPERTIES_KEY_MAP[key]}`,
            );
          }
          continue;
        }
        // 特判时间！妈蛋
        if (dataName === "Char_Skill_16073" && PROPERTIES_KEY_MAP[key] === "D__KEY__DAMAGE") {
          value = 3;
        } else if (dataName === "Char_Skill_25032" && PROPERTIES_KEY_MAP[key] === "D__KEY__DAMAGE") {
          value = 3;
        }
        tcgSkillKeyMap[dataName][PROPERTIES_KEY_MAP[key]] = value;
      }
    }
  } catch (e) {
    continue;
  }
}
console.log("loadTcgSkillKeyMap done");

export interface PlayCost {
  type: string;
  count: number;
}

export interface SkillRawData {
  id: number;
  type: string;
  name: string;
  englishName: string;
  rawDescription: string;
  description: string;
  playCost: PlayCost[];
  keyMap: Record<string, any>;
  icon?: string;
}

export async function collateSkill(
  langCode: string,
  skillId: number,
): Promise<SkillRawData | null> {
  const locale = getLanguage(langCode);
  const english = getLanguage("EN");
  const skillObj = xskill.find((e) => e.id === skillId)!;

  const id = skillId;
  const type = skillObj.skillTagList[0];
  if (type === "GCG_TAG_NONE") {
    return null;
  }
  const [name, englishName] = [locale, english].map((lc) =>
    sanitizeName(lc[skillObj.nameTextMapHash] ?? ""),
  );

  const rawDescription = locale[skillObj.descTextMapHash] ?? "";
  const keyMap = tcgSkillKeyMap[skillObj.skillJson];
  const descriptionReplaced = getDescriptionReplaced(
    rawDescription,
    locale,
    keyMap,
  );
  const description = sanitizeDescription(descriptionReplaced, true);

  const playCost = skillObj.costList
    .filter((e: any) => e.count)
    .map((e: any) => ({
      type: e.costType,
      count: e.count,
    }));

  const iconHash = skillObj.skillIconHash;
  const icon = await getSkillIcon(id, iconHash);
  // const icon = iconHash;

  return {
    id,
    name,
    englishName,
    type,
    rawDescription,
    description,
    playCost,
    keyMap,
    icon,
  };
}
