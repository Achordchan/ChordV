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
  return (
    <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
      <Tabs value={props.planScopeTab} onChange={(value) => props.onPlanScopeTabChange((value as PlanScope) || "personal")}>
        <Tabs.List>
          <Tabs.Tab value="personal">个人套餐</Tabs.Tab>
          <Tabs.Tab value="team">Team 套餐</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={props.planScopeTab} pt="md">
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>名称</Table.Th>
                <Table.Th>总流量</Table.Th>
                <Table.Th>续费</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>订阅数</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.plans.filter((item) => item.scope === props.planScopeTab).map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.name}</Table.Td>
                  <Table.Td>{item.totalTrafficGb} GB</Table.Td>
                  <Table.Td>{item.renewable ? "可续费" : "不可续费"}</Table.Td>
                  <Table.Td>
                    <StatusBadge color={item.isActive ? "green" : "gray"} label={item.isActive ? "启用" : "停用"} />
                  </Table.Td>
                  <Table.Td>{item.subscriptionCount}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" onClick={() => props.onOpenPlanDrawer(item.id)}>
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
