import { Injectable } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Injectable()
export class AuthService {
  constructor(private readonly devDataService: DevDataService) {}

  login(email: string, password: string) {
    return this.devDataService.login(email, password);
  }

  refresh(refreshToken: string) {
    return this.devDataService.refresh(refreshToken);
  }

  logout() {
    return this.devDataService.logout();
  }
}
