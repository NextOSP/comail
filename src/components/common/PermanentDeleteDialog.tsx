import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { performPermanentDelete } from "../../queries/actions";
import { useUi } from "../../stores/ui";
import { Modal } from "../ui/Modal";

export function PermanentDeleteDialog() {
  const { t } = useTranslation();
  const targets = useUi((s) => s.permanentDeleteTarget);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  if (!targets) return null;
  const close = () => {
    if (!submitting.current) useUi.getState().set({ permanentDeleteTarget: null });
  };
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const accepted = await performPermanentDelete(targets);
      if (accepted && useUi.getState().permanentDeleteTarget === targets) {
        useUi.getState().set({ permanentDeleteTarget: null });
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal onClose={close} closeOnEsc labelledBy="permanent-delete-title" className="p-5">
      <h2 id="permanent-delete-title" className="text-lg font-semibold text-ink">
        {t("common:permanentDelete.title")}
      </h2>
      <p className="mt-3 text-base text-ink-muted">
        {t("common:permanentDelete.confirm", { count: targets.length })}
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <button autoFocus disabled={busy} className="rounded-control border border-hairline px-4 py-2 text-ink" onClick={close}>
          {t("common:action.cancel")}
        </button>
        <button disabled={busy} aria-busy={busy} className="rounded-control bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-50" onClick={() => void confirm()}>
          {t("common:permanentDelete.title")}
        </button>
      </div>
    </Modal>
  );
}
