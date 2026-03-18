import { Injectable } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Injectable()
export class ClientService {
  constructor(private readonly devDataService: DevDataService) {}

  getBootstrap(token?: string) {
    return this.devDataService.getBootstrap(token);
  }

  getSubscription(token?: string) {
    return this.devDataService.getSubscription(token);
  }

  getNodes(token?: string) {
    return this.devDataService.getNodes(token);
  }

  getPolicies() {
    return this.devDataService.getPolicies();
  }

  getVersion() {
    return this.devDataService.getBootstrap().then((result) => result.version);
  }

  connect(nodeId: string, mode: "global" | "rule" | "direct", strategyGroupId?: string, token?: string) {
    return this.devDataService.connect({ nodeId, mode, strategyGroupId }, token);
  }

  disconnect(token?: string) {
    return this.devDataService.disconnect();
  }

  getRuntime() {
    return this.devDataService.getActiveRuntime();
  }
}
