import { ActionIcon, Table, Tabs } from "@mantine/core";
import type { AdminPlanRecordDto, PlanScope } from "@chordv/shared";
import { IconPencil } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";

type PlansPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  planScopeTab: PlanScope;
  onPlanScopeTabChange: (value: PlanScope) => void;
  plans: AdminPlanRecordDto[];
  onOpenPlanDrawer: (planId: string) => void;
};

export function PlansPage(props: PlansPageProps) {
  const personalPlans = props.plans.filter((item) => item.scope === "personal");
  const teamPlans = props.plans.filter((item) => item.scope === "team");
  const currentPlans = props.planScopeTab === "personal" ? personalPlans : teamPlans;

  return (
    <SectionCard
      title="套餐规则"
      description="管理个人和 Team 套餐模板，控制流量、并发和续费能力。"
      searchValue={props.searchValue}
      onSearchChange={props.onSearchChange}
      searchPlaceholder="搜索套餐名称"
    >
      <Tabs value={props.planScopeTab} onChange={(value) => props.onPlanScopeTabChange((value as PlanScope) || "personal")}>
        <Tabs.List>
          <Tabs.Tab value="personal">个人套餐 · {personalPlans.length}</Tabs.Tab>
          <Tabs.Tab value="team">Team 套餐 · {teamPlans.length}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={props.planScopeTab} pt="md">
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>名称</Table.Th>
                <Table.Th>总流量</Table.Th>
                <Table.Th>最大并发</Table.Th>
                <Table.Th>续费</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>订阅数</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {currentPlans.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.name}</Table.Td>
                  <Table.Td>{item.totalTrafficGb} GB</Table.Td>
                  <Table.Td>{item.maxConcurrentSessions}</Table.Td>
                  <Table.Td>{item.renewable ? "可续费" : "不可续费"}</Table.Td>
                  <Table.Td>
                    <StatusBadge color={item.isActive ? "green" : "gray"} label={item.isActive ? "启用" : "停用"} />
                  </Table.Td>
                  <Table.Td>{item.subscriptionCount}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" onClick={() => props.onOpenPlanDrawer(item.id)} title="编辑套餐" aria-label="编辑套餐">
                      <IconPencil size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </DataTable>
        </Tabs.Panel>
      </Tabs>
    </SectionCard>
  );
}
