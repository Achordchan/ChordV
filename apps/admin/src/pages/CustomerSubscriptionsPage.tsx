import type { ReactNode } from "react";
import { Badge, Group, Tabs, Text } from "@mantine/core";

type CustomerSubscriptionsTab = "customers" | "subscriptions";

export function CustomerSubscriptionsPage(props: {
  activeTab: CustomerSubscriptionsTab;
  onTabChange: (tab: CustomerSubscriptionsTab) => void;
  customerCount: number;
  teamCount: number;
  personalSubscriptionCount: number;
  teamSubscriptionCount: number;
  customers: ReactNode;
  subscriptions: ReactNode;
}) {
  const subscriptionCount = props.personalSubscriptionCount + props.teamSubscriptionCount;

  return (
    <Tabs value={props.activeTab} onChange={(value) => props.onTabChange((value as CustomerSubscriptionsTab) || "customers")}>
      <Tabs.List>
        <Tabs.Tab value="customers">
          <Group gap={6} wrap="nowrap">
            <span>客户与团队</span>
            <Badge size="xs" variant="light" color="blue">
              {props.customerCount + props.teamCount}
            </Badge>
          </Group>
        </Tabs.Tab>
        <Tabs.Tab value="subscriptions">
          <Group gap={6} wrap="nowrap">
            <span>订阅与授权</span>
            <Badge size="xs" variant="light" color="green">
              {subscriptionCount}
            </Badge>
          </Group>
        </Tabs.Tab>
      </Tabs.List>
      <Text size="sm" c="dimmed" mt="xs">
        先按客户定位账号和团队，再处理订阅、节点授权、续期和流量动作。
      </Text>

      <Tabs.Panel value="customers" pt="md">
        {props.customers}
      </Tabs.Panel>
      <Tabs.Panel value="subscriptions" pt="md">
        {props.subscriptions}
      </Tabs.Panel>
    </Tabs>
  );
}

