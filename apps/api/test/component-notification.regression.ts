import assert from "node:assert/strict";
import { ClientEventsPublisher } from "../src/modules/common/client-events.publisher";

async function main() {
  const seen: Array<{users:string[];event:any}> = [];
  let reject = false;
  const publisher = new ClientEventsPublisher({user:{findMany:async()=>[{id:"one"},{id:"two"}]}} as never, {
    publishToUsersReliable: async (users:string[], event:unknown) => {
      if (reject) throw new Error("cluster unavailable");
      seen.push({users,event});
    }
  } as never);
  await publisher.publishRuntimeComponentsUpdated("windows");
  assert.deepEqual(seen[0].users,["one","two"]);
  assert.equal(seen[0].event.type,"runtime_component_updated");
  assert.equal(seen[0].event.platform,"windows");
  await publisher.publishRuntimeComponentsUpdated(null);
  assert.equal(seen[1].event.platform,null,"shared rule changes reach both desktop platforms");
  reject = true;
  await assert.rejects(publisher.publishRuntimeComponentsUpdated(null),/cluster unavailable/,"broadcast failure must propagate so the durable pending flag is not cleared");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
