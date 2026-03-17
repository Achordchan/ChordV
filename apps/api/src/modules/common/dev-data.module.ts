import { Global, Module } from "@nestjs/common";
import { DevDataService } from "./dev-data.service";

@Global()
@Module({
  providers: [DevDataService],
  exports: [DevDataService]
})
export class DevDataModule {}
