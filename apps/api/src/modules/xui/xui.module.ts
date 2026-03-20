import { Module } from "@nestjs/common";
import { XuiService } from "./xui.service";

@Module({
  providers: [XuiService],
  exports: [XuiService]
})
export class XuiModule {}
