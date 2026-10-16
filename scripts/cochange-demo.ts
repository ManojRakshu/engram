// Demo/verification of the cross-layer hint on the click graph: simulate an edit of types.py.
import { RepoGraph, close, latencyStats } from "../src/db.ts";
import { startSession, recordFileEvent } from "../src/memory.ts";
import { hintCoChangeGap } from "../src/core/jit.ts";
const g = await RepoGraph.open("pallets-click");
const sid = await startSession(g, { agent: "demo", task: "fix bool parsing" });
await recordFileEvent(g, sid, "src/click/types.py", "EDITED");
console.log(await hintCoChangeGap(g, sid, "src/click/types.py", new Set()));
await recordFileEvent(g, sid, "src/click/core.py", "EDITED");
console.log("after also editing core.py →", await hintCoChangeGap(g, sid, "src/click/types.py", new Set()));
console.log(latencyStats()["jit.cochangeGap"]);
await g.write("demo.cleanup", "MATCH (s:Session {id: $sid}) DETACH DELETE s", { sid });
await close();
