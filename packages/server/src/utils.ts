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
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import type { Deck } from "@gi-tcg/utils";
import {
  characters as characterData,
  actionCards as actionCardData,
} from "@gi-tcg/static-data";
import { IsInt, IsOptional, IsPositive, Max } from "class-validator";
import { CURRENT_VERSION, VERSIONS, type Version } from "@gi-tcg/core";
import { semver } from "bun";
import { Transform, type TransformFnParams } from "class-transformer";

export enum DeckVerificationErrorCode {
  SizeError = "SizeError",
  NotFoundError = "NotFoundError",
  CountLimitError = "CountLimitError",
  RelationError = "RelationError",
}

export class DeckVerificationError extends Error {
  constructor(
    public readonly code: DeckVerificationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const CHARACTERS_MAP = Object.fromEntries(
  characterData.map((ch) => [ch.id, ch]),
);
const ACTION_CARDS_MAP = Object.fromEntries(
  actionCardData.map((c) => [c.id, c]),
);

/**
 * 校验牌组合法性
 * @param param0 牌组
 * @returns 牌组可以打出的最低游戏版本
 */
export function verifyDeck({ characters, cards }: Deck): Version {
  const DEC = DeckVerificationErrorCode;
  const versions = new Set<string | undefined>();
  const characterSet = new Set(characters);
  if (characterSet.size !== 3) {
    throw new DeckVerificationError(
      DEC.SizeError,
      "deck must contain 3 characters",
    );
  }
  if (cards.length !== 30) {
    throw new DeckVerificationError(
      DEC.SizeError,
      "deck must contain 30 cards",
    );
  }
  const characterTags = [];
  for (const chId of characters) {
    const character = CHARACTERS_MAP[chId];
    if (!character) {
      throw new DeckVerificationError(
        DEC.NotFoundError,
        `character id ${chId} not found`,
      );
    }
    if (!character.obtainable) {
      throw new DeckVerificationError(
        DEC.NotFoundError,
        `character id ${chId} not obtainable`,
      );
    }
    characterTags.push(...character.tags);
    versions.add(character.sinceVersion);
  }
  const cardCounts = new Map<number, number>();
  for (const cardId of cards) {
    const card = ACTION_CARDS_MAP[cardId];
    if (!card) {
      throw new DeckVerificationError(
        DEC.NotFoundError,
        `card id ${cardId} not found`,
      );
    }
    const cardMaxCount = card?.tags.includes("GCG_TAG_LEGEND") ? 1 : 2;
    if (cardCounts.has(cardId)) {
      const count = cardCounts.get(cardId)! + 1;
      if (count > cardMaxCount) {
        throw new DeckVerificationError(
          DEC.CountLimitError,
          `card id ${cardId} exceeds max count`,
        );
      }
      cardCounts.set(cardId, count);
    } else {
      if (!card.obtainable) {
        throw new DeckVerificationError(
          DEC.RelationError,
          `card id ${cardId} not obtainable`,
        );
      }
      if (
        card.relatedCharacterId !== null &&
        !characters.includes(card.relatedCharacterId)
      ) {
        throw new DeckVerificationError(
          DEC.RelationError,
          `card id ${cardId} related character not in deck`,
        );
      }
      const tempCharacterTags = [...characterTags];
      for (const requiredTag of card.relatedCharacterTags) {
        const idx = tempCharacterTags.indexOf(requiredTag);
        if (idx === -1) {
          throw new DeckVerificationError(
            DEC.RelationError,
            `card id ${cardId} related character tags not in deck`,
          );
        }
        tempCharacterTags.splice(idx, 1);
      }
      cardCounts.set(cardId, 1);
      versions.add(card.sinceVersion);
    }
  }
  return maxVersion(versions);
}

function maxVersion(versions: Iterable<string | undefined>): Version {
  const ver = [...versions]
    .filter((v): v is string => !!v)
    .toSorted(semver.order)
    .last();
  if (!VERSIONS.includes(ver as Version)) {
    return CURRENT_VERSION;
  } else {
    return ver as Version;
  }
}

export function minimumRequiredVersionOfDeck({
  characters,
  cards,
}: Deck): Version {
  return maxVersion([
    ...characters.map((id) => CHARACTERS_MAP[id]?.sinceVersion),
    ...cards.map((id) => ACTION_CARDS_MAP[id]?.sinceVersion),
  ]);
}

export function parseStringToInt({ value }: TransformFnParams): number {
  return typeof value !== "string" || value.trim() === "" ? NaN : Number(value);
}

export class PaginationDto {
  @IsInt()
  @IsPositive()
  @IsOptional()
  @Transform(parseStringToInt)
  skip?: number;

  @IsInt()
  @IsPositive()
  @Max(30)
  @IsOptional()
  @Transform(parseStringToInt)
  take?: number;
}

export interface PaginationResult<T> {
  count: number;
  data: T[];
}
