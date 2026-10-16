import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt = await ModelRuntime.create();
const all = (rt as any).getAll ? (rt as any).getAll() : (rt as any).getModels?.() ?? [];
const list = Array.isArray(all) ? all : [];
console.log("total", list.length, Object.getOwnPropertyNames(Object.getPrototypeOf(rt)).join(","));
for (const m of list.filter((m: any) => m.provider === "amazon-bedrock" && /haiku|sonnet/.test(m.id))) console.log(m.id, "in", m.cost?.input, "out", m.cost?.output, "cacheRead", m.cost?.cacheRead);
