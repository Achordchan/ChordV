import { Code, Drawer, ScrollArea, Stack, Text, Title } from "@mantine/core";

type LogDrawerProps = {
  opened: boolean;
  log: string;
  onClose: () => void;
};

export function LogDrawer(props: LogDrawerProps) {
  return (
    <Drawer opened={props.opened} onClose={props.onClose} position="right" size={420} title="运行日志">
      <Stack gap="md" h="100%">
        <div>
          <Title order={4}>Xray 日志</Title>
          <Text size="sm" c="dimmed" mt={4}>
            默认隐藏，需要时手动展开查看
          </Text>
        </div>

        <ScrollArea h="100%">
          <Code block className="log-viewer">
            {props.log || "当前没有日志"}
          </Code>
        </ScrollArea>
      </Stack>
    </Drawer>
  );
}
