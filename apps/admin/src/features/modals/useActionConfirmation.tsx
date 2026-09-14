import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Text } from "@mantine/core";
import styles from "../editors/EditorDialog.module.css";

type Request = { title: string; message: string; confirmLabel: string; danger?: boolean };

/** Resolve cancelled requests on unmount/session loss; never carry an
 * unconfirmed operation into another authenticated session. */
export function useActionConfirmation(sessionActive: boolean) {
  const [request, setRequest] = useState<Request | null>(null);
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null; setRequest(null); resolve?.(accepted);
  }, []);
  useEffect(() => { if (!sessionActive) settle(false); }, [sessionActive, settle]);
  useEffect(() => () => { resolveRef.current?.(false); resolveRef.current = null; }, []);
  const confirm = useCallback((value: Request) => {
    if (!sessionActive || resolveRef.current) return Promise.resolve(false);
    setRequest(value);
    return new Promise<boolean>(resolve => { resolveRef.current = resolve; });
  }, [sessionActive]);
  const dialog = <Modal opened={Boolean(request)} onClose={() => settle(false)} title={request?.title} centered size="sm" zIndex={400}
    overlayProps={{ backgroundOpacity: .35, blur: 2 }} classNames={{ content: styles.content, header: styles.header, title: styles.title, body: styles.body }}>
    <Text size="sm" lh={1.8} style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{request?.message}</Text>
    <footer className={styles.footer}><Button variant="default" onClick={() => settle(false)}>取消</Button><Button color={request?.danger ? "red" : "#1c4d37"} onClick={() => settle(true)}>{request?.confirmLabel}</Button></footer>
  </Modal>;
  return { confirm, dialog };
}
