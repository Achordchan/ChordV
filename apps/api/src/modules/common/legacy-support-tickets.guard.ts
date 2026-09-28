import { CanActivate, GoneException, Injectable } from "@nestjs/common";

/**
 * 自建工单已由新工单系统（Achord Connect）取代，历史数据只读保留。
 * 写接口在守卫里直接拒绝：守卫先于上传拦截器执行，被拒绝的请求不会再读取或暂存附件。
 */
export const LEGACY_CLIENT_TICKET_WRITE_MESSAGE = "工单系统已升级，请更新到最新版客户端后提交工单";
export const LEGACY_ADMIN_TICKET_WRITE_MESSAGE = "工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。";

/**
 * 旧版客户端（1.1.10 及更早）新建、回复、上传附件时返回 410 和中文提示。
 * 这些版本对 4xx 的中文 message 原样展示（1.1.10 的 describeUserError 对“客户可读”的 4xx 文案直接展示，
 * 更早版本直接展示 message），所以客户看到的就是这句提示。须排在 ClientAuthGuard 之后，登录失效仍按 401 处理。
 */
@Injectable()
export class LegacyClientTicketWriteGuard implements CanActivate {
  canActivate(): boolean {
    throw new GoneException(LEGACY_CLIENT_TICKET_WRITE_MESSAGE);
  }
}

/** 后台对旧工单的回复、关闭、重开一律拒绝（后台页面已改为只读，这里是兜底）。 */
@Injectable()
export class LegacyAdminTicketWriteGuard implements CanActivate {
  canActivate(): boolean {
    throw new GoneException(LEGACY_ADMIN_TICKET_WRITE_MESSAGE);
  }
}
