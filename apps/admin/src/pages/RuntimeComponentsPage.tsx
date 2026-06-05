import { useEffect, useState } from "react";
import { notifications } from "@mantine/notifications";
import type {
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto
} from "../api/client";
import {
  fetchAdminRuntimeComponentFailures,
  fetchAdminRuntimeComponents
} from "../api/client";
import { RuntimeComponentsPanel } from "../features/runtime-components/RuntimeComponentsPanel";
import { readError } from "../utils/admin-filters";

export function RuntimeComponentsPage() {
  const [runtimeComponents, setRuntimeComponents] = useState<AdminRuntimeComponentRecordDto[]>([]);
  const [runtimeFailures, setRuntimeFailures] = useState<AdminRuntimeComponentFailureReportDto[]>([]);
  const [runtimeValidation, setRuntimeValidation] = useState<Record<string, AdminRuntimeComponentValidationDto>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadRuntimeComponents();
  }, []);

  async function loadRuntimeComponents() {
    try {
      setRuntimeLoading(true);
      setRuntimeError(null);
      const [components, failures] = await Promise.all([fetchAdminRuntimeComponents(), fetchAdminRuntimeComponentFailures()]);
      setRuntimeComponents(components);
      setRuntimeFailures(failures);
    } catch (reason) {
      const message = readError(reason, "加载内核组件失败");
      setRuntimeError(message);
      notifications.show({
        color: "red",
        title: "内核组件",
        message
      });
    } finally {
      setRuntimeLoading(false);
    }
  }

  return (
    <RuntimeComponentsPanel
      components={runtimeComponents}
      failures={runtimeFailures}
      validations={runtimeValidation}
      loading={runtimeLoading}
      error={runtimeError}
      saving={saving}
      onRefresh={loadRuntimeComponents}
      onComponentsChange={setRuntimeComponents}
      onFailuresChange={setRuntimeFailures}
      onValidationChange={(componentId, next) =>
        setRuntimeValidation((current) => {
          const updated = { ...current };
          if (next) {
            updated[componentId] = next;
          } else {
            delete updated[componentId];
          }
          return updated;
        })
      }
      onSavingChange={setSaving}
    />
  );
}
