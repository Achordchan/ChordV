import { useEffect, useState } from "react";
import { notifications } from "@mantine/notifications";
import type {
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto
} from "../api/client";
import {
  fetchAdminUploadLimits,
  fetchAdminRuntimeComponentFailures,
  fetchAdminRuntimeComponents
} from "../api/client";
import {
  DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES,
  RuntimeComponentsPanel
} from "../features/runtime-components/RuntimeComponentsPanel";
import { readError } from "../utils/admin-filters";

export function RuntimeComponentsPage() {
  const [runtimeComponents, setRuntimeComponents] = useState<AdminRuntimeComponentRecordDto[]>([]);
  const [runtimeFailures, setRuntimeFailures] = useState<AdminRuntimeComponentFailureReportDto[]>([]);
  const [runtimeValidation, setRuntimeValidation] = useState<Record<string, AdminRuntimeComponentValidationDto>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadMaxBytes, setUploadMaxBytes] = useState(DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES);

  useEffect(() => {
    void loadRuntimeComponents();
    void loadUploadLimits();
  }, []);

  async function loadUploadLimits() {
    try {
      const limits = await fetchAdminUploadLimits();
      setUploadMaxBytes(limits.runtimeComponentMaxBytes || DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES);
    } catch {
      setUploadMaxBytes(DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES);
    }
  }

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
      uploadMaxBytes={uploadMaxBytes}
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
