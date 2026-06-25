import { Alert, Button, Card, Checkbox, Group, Select, Stack, Switch, Text, Title } from "@mantine/core";
import type { ConnectionMode } from "@chordv/shared";
import type { Dispatch, SetStateAction } from "react";
import type { PolicyFormState } from "../utils/admin-forms";
import { modeOptions } from "../utils/admin-forms";

type PoliciesPageProps = {
  policyForm: PolicyFormState;
  setPolicyForm: Dispatch<SetStateAction<PolicyFormState | null>>;
  policySaving: boolean;
  onSave: () => void;
};

export function PoliciesPage(props: PoliciesPageProps) {
  return (
    <Card withBorder radius="xl" p="lg">
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={4}>连接策略</Title>
          <Text size="sm" c="dimmed">
            配置客户端默认连接模式、可选模式和基础分流规则。
          </Text>
        </Stack>
        <Alert color="blue" variant="light">
          当前使用 3x-ui 直连接入，中心负责开通、删号与汇总计量。版本发布请到“发布中心”单独管理。
        </Alert>
        <Select
          label="默认模式"
          data={modeOptions}
          value={props.policyForm.defaultMode}
          onChange={(value) =>
            props.setPolicyForm((current) => (current ? { ...current, defaultMode: (value || "rule") as ConnectionMode } : current))
          }
        />
        <Checkbox.Group
          label="可用模式"
          value={props.policyForm.modes}
          onChange={(value) => props.setPolicyForm((current) => (current ? { ...current, modes: value as ConnectionMode[] } : current))}
        >
          <Group mt="xs">
            <Checkbox value="rule" label="规则模式" />
            <Checkbox value="global" label="全局代理" />
            <Checkbox value="direct" label="直连模式" />
          </Group>
        </Checkbox.Group>
        <Group grow>
          <Switch
            checked={props.policyForm.blockAds}
            onChange={(event) =>
              props.setPolicyForm((current) => (current ? { ...current, blockAds: event.currentTarget.checked } : current))
            }
            label="广告拦截"
          />
          <Switch
            checked={props.policyForm.chinaDirect}
            onChange={(event) =>
              props.setPolicyForm((current) => (current ? { ...current, chinaDirect: event.currentTarget.checked } : current))
            }
            label="大陆直连"
          />
          <Switch
            checked={props.policyForm.aiServicesProxy}
            onChange={(event) =>
              props.setPolicyForm((current) => (current ? { ...current, aiServicesProxy: event.currentTarget.checked } : current))
            }
            label="AI 代理"
          />
        </Group>
        <Group justify="flex-end">
          <Button onClick={props.onSave} loading={props.policySaving}>
            保存策略
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
