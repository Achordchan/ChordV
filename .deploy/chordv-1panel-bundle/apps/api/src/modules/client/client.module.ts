import { Module } from "@nestjs/common";
import { ClientController } from "./client.controller";
import { ClientService } from "./client.service";
import { DownloadsController } from "./downloads.controller";

@Module({
  controllers: [ClientController, DownloadsController],
  providers: [ClientService]
})
export class ClientModule {}
