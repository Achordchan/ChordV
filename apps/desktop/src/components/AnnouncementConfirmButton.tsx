import { Button } from "@mantine/core";
import { useEffect, useState } from "react";

export function AnnouncementConfirmButton({ seconds, onConfirm }: { seconds: number; onConfirm: () => void }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return <Button data-autofocus disabled={remaining > 0} onClick={onConfirm}>
    {remaining > 0 ? `请等待 ${remaining}s` : "我知道了"}
  </Button>;
}
