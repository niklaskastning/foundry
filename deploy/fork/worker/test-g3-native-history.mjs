import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "g3-native-history-"));
const fake = NodePath.join(directory, "fixture.cjs");
await NodeFSP.writeFile(
  fake,
  `
const readline = require('node:readline');
const scenario = process.argv[2];
readline.createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line); if(request.method==='initialized')return;
 if(!['initialize','thread/read'].includes(request.method))process.exit(3);
 let result={};
 if(request.method==='thread/read'){
  const child=request.params.threadId==='child';
  const items=[];
  if(scenario==='command-running')items.push({type:'commandExecution',status:'inProgress'});
  if(scenario.startsWith('child-')&&!child)items.push({type:'subAgentActivity',agentThreadId:'child'});
  result={thread:{status:{type:'notLoaded'},turns:[{id:scenario==='missing-turn'?'other':child?'child-turn':'turn',status:scenario==='in-progress'||child&&scenario==='child-running'?'inProgress':'interrupted',itemsView:scenario==='missing-full'?'summary':'full',items}]}};
 }
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
);
try {
  for (const scenario of [
    "stopped",
    "in-progress",
    "command-running",
    "missing-full",
    "missing-turn",
    "child-running",
    "child-stopped",
  ]) {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["deploy/fork/worker/g3-native-history.cjs"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      error += bytes;
    });
    child.stdin.end(
      JSON.stringify({
        command: process.execPath,
        args: [fake, scenario],
        threadId: "root",
        turnId: "turn",
      }),
    );
    const exit = await new Promise((resolve) => child.on("exit", resolve));
    NodeAssert.equal(exit, 0, error);
    const report = JSON.parse(output);
    NodeAssert.equal(
      report.nativeStopConfirmed,
      ["stopped", "child-stopped"].includes(scenario),
      scenario,
    );
    NodeAssert.equal(report.threadsChecked, scenario.startsWith("child-") ? 2 : 1);
  }
} finally {
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
console.log(
  "Read-only native history rejects live commands, turns, children and incomplete history; no turn/start or thread/resume",
);
