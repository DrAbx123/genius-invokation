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

import type { DiceType } from "@gi-tcg/typings";
import { Index, Show, createEffect, mergeProps } from "solid-js";
import { checkDice, chooseDice } from "@gi-tcg/utils";

import { Dice } from "./Dice";
import { createStore, produce } from "solid-js/store";

export interface DiceSelectProps {
  required?: readonly DiceType[];
  value: readonly DiceType[];
  disabledDice?: readonly DiceType[];
  confirmOnly?: boolean;
  disableConfirm?: boolean;
  onConfirm?: (dice: DiceType[]) => void;
  onCancel?: () => void;
}

export function DiceSelect(props: DiceSelectProps) {
  const merged = mergeProps(
    {
      confirmOnly: false,
      disableConfirm: false,
      required: [] as readonly DiceType[],
      disabledDice: [] as readonly DiceType[],
    },
    props,
  );
  const [chosen, setChosen] = createStore<boolean[]>([]);
  createEffect(() => {
    const autoChosen = chooseDice(
      merged.required,
      merged.value.filter((d) => !merged.disabledDice.includes(d)),
    );
    const chosenResult = [];
    for (let i = 0; i < merged.value.length; i++) {
      if (merged.disabledDice.includes(merged.value[i])) {
        chosenResult.push(false);
      } else {
        chosenResult.push(autoChosen.shift()!);
      }
    }
    setChosen(chosenResult);
  });
  const chosenDice = () => props.value.filter((_, i) => chosen[i]);
  const flipChosen = (index: number) => {
    setChosen(produce((p) => void (p[index] = !p[index])));
  };
  const isValid = () => checkDice(merged.required, chosenDice());
  return (
    <div class="h-full w-full p-3 flex flex-col justify-between items-center">
      <ul
        class="grid grid-cols-2"
        classList={{ "opacity-60": merged.confirmOnly }}
      >
        <Index each={merged.value}>
          {(d, i) => (
            <li
              classList={{ "opacity-60": merged.disabledDice.includes(d()) }}
              onClick={() =>
                !merged.confirmOnly &&
                !merged.disabledDice.includes(d()) &&
                flipChosen(i)
              }
            >
              <Dice type={d()} selected={chosen[i]} size={40} />
            </li>
          )}
        </Index>
      </ul>
      <div class="flex flex-col gap-1">
        <button
          class="btn btn-yellow text-black"
          disabled={merged.disableConfirm || !isValid()}
          onClick={() => merged.onConfirm?.(chosenDice())}
        >
          确认
        </button>
        <Show when={!merged.confirmOnly}>
          <button
            class="btn btn-red"
            onClick={() => merged.onCancel?.()}
          >
            取消
          </button>
        </Show>
      </div>
    </div>
  );
}
