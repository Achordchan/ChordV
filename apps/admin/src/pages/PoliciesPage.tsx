import { Alert, Button, Card, Checkbox, Group, Select, SimpleGrid, Stack, Switch, TextInput, Textarea, Title } from "@mantine/core";
import type { AccessMode, ConnectionMode } from "@chordv/shared";
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
        <SimpleGrid cols={{ base: 1, xl: 2 }}>
          <Card withBorder radius="xl" p="lg">
            <Stack gap="md">
              <Title order={4}>基础策略</Title>
              <Select
                label="接入模式"
                data={[
                  { value: "xui", label: "3x-ui 直连模式" },
                  { value: "relay", label: "中心中转模式" }
                ]}
                value={props.policyForm.accessMode}
                onChange={(value) =>
                  props.setPolicyForm((current) => (current ? { ...current, accessMode: (value || "xui") as AccessMode } : current))
                }
              />
              {props.policyForm.accessMode === "xui" ? (
                <Alert color="blue" variant="light">
                  当前使用 3x-ui 直连接入，中心负责开通、删号与汇总计量。
                </Alert>
              ) : (
                <Alert color="yellow" variant="light">
                  当前使用中心中转接入，客户端不会直接拿到真实节点参数，但需要额外中转资源。
                </Alert>
              )}
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
            </Stack>
          </Card>

          <Card withBorder radius="xl" p="lg">
            <Stack gap="md">
              <Title order={4}>版本更新</Title>
              <TextInput
                label="当前版本"
                value={props.policyForm.currentVersion}
                onChange={(event) =>
                  props.setPolicyForm((current) => (current ? { ...current, currentVersion: event.currentTarget.value } : current))
                }
              />
              <TextInput
                label="最低版本"
                value={props.policyForm.minimumVersion}
                onChange={(event) =>
                  props.setPolicyForm((current) => (current ? { ...current, minimumVersion: event.currentTarget.value } : current))
                }
              />
              <Switch
                checked={props.policyForm.forceUpgrade}
                onChange={(event) =>
                  props.setPolicyForm((current) => (current ? { ...current, forceUpgrade: event.currentTarget.checked } : current))
                }
                label="强制升级"
              />
              <TextInput
                label="下载地址"
                value={props.policyForm.downloadUrl}
                onChange={(event) =>
                  props.setPolicyForm((current) => (current ? { ...current, downloadUrl: event.currentTarget.value } : current))
                }
              />
              <Textarea
                label="更新日志"
                minRows={6}
                value={props.policyForm.changelog}
                onChange={(event) =>
                  props.setPolicyForm((current) => (current ? { ...current, changelog: event.currentTarget.value } : current))
                }
              />
            </Stack>
          </Card>
        </SimpleGrid>
        <Group justify="flex-end">
          <Button onClick={props.onSave} loading={props.policySaving}>
            保存策略
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
