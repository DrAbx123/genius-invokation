
const fetched = new Map<number, any>();

const MAPPING_FILE = `${import.meta.dirname}/mappings/skill_icons.json`;

export async function getSkillIcon(skillId: number, iconHash?: number | bigint): Promise<string | undefined> {
  if (typeof iconHash === "undefined") {
    return;
  }
  const mapping = await Bun.file(MAPPING_FILE).json();
  if (Reflect.has(mapping, String(iconHash))) {
    return mapping[String(iconHash)];
  }
  console.log(`Skill id ${skillId} has unknown icon hash ${iconHash}, find it on ambr.top...`);

  const chId = Math.floor(skillId / 10);
  let data: { talent: Record<number, { icon: string | null }> };
  if (fetched.has(chId)) {
    data = fetched.get(chId)!;
  } else {
    const url = `https://api.ambr.top/v2/en/gcg/${chId}`;
    const body = await fetch(url, {
      proxy: process.env.https_proxy,
    }).then((r) => r.json() as Promise<any>);
    if (body.response !== 200) {
      console.warn(`Failed to fetch ${chId}`);
      return;
    }
    data = body.data
  }
  const skillObj = data.talent[skillId];
  if (!skillObj) {
    console.warn(`We do not found skill ${skillId} on character ${chId}`);
    return;
  }
  if (skillObj.icon === null) {
    console.warn(`No icon provided for ${skillId}`);
    return;
  }

  mapping[String(iconHash)] = skillObj.icon;
  await Bun.write(MAPPING_FILE, JSON.stringify(mapping, null, 2));

  return skillObj.icon;
}
