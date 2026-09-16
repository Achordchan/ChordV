import { notifications as mantineNotifications } from "@mantine/notifications";

/** Identical text notices share an ID while visible or queued. Once dismissed,
 * a later occurrence can be shown again. Explicit business IDs remain intact. */
export const notifications: typeof mantineNotifications = {
  ...mantineNotifications,
  show(notice, store) {
    const textMessage = typeof notice.message === "string";
    const textTitle = notice.title == null || typeof notice.title === "string";
    const id = notice.id ?? (textMessage && textTitle
      ? `client-notice:${JSON.stringify([notice.color ?? null, notice.title ?? null, notice.message])}`
      : undefined);
    return mantineNotifications.show({ ...notice, id }, store);
  }
};
