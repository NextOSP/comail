import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts } from "../../../queries/hooks";
import { Icon } from "../../ui/Icon";
import { ImapForm, OAuthButtons, useOAuth } from "../connect";
import { PrimaryCta, SPRING, Stagger, StepHeader } from "../flowParts";

/** Connect the first account. A successful sign-in advances the flow; with an
 *  account already present (a preview run, or Back from a later step) the
 *  step shows who is connected and offers to continue or add another. */
export function ConnectStep({
  onNext,
  onWaiting,
}: {
  onNext: () => void;
  /** True while an OAuth sign-in is out in the browser (drives the preview). */
  onWaiting: (waiting: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const [form, setForm] = useState(false);
  const advance = () => window.setTimeout(onNext, 450);
  const oauth = useOAuth({ onDone: advance });

  useEffect(() => {
    onWaiting(oauth.busy != null);
  }, [oauth.busy, onWaiting]);
  useEffect(() => () => onWaiting(false), [onWaiting]);

  const first = accounts?.[0];

  return (
    <Stagger className="flex flex-col">
      <StepHeader
        title={t("onboarding:flow.connect.title")}
        body={t("onboarding:flow.connect.body")}
      />
      <AnimatePresence mode="wait" initial={false}>
        {form ? (
          <motion.div
            key="form"
            className="mt-6"
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0, transition: SPRING }}
            exit={{ opacity: 0, x: 18, transition: { duration: 0.14 } }}
          >
            <ImapForm onDone={advance} onBack={() => setForm(false)} />
          </motion.div>
        ) : (
          <motion.div
            key="methods"
            className="mt-7 flex flex-col gap-2.5"
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0, transition: SPRING }}
            exit={{ opacity: 0, x: -18, transition: { duration: 0.14 } }}
          >
            {first && (
              <div className="mb-3">
                <div className="co-onb-connected">
                  <span className="co-onb-check is-ok">
                    <Icon name="check" size={11} />
                  </span>
                  <span className="min-w-0 truncate">
                    {t("onboarding:flow.connect.connected", { email: first.email })}
                  </span>
                </div>
              </div>
            )}
            {first ? (
              <>
                <div>
                  <PrimaryCta onClick={onNext}>{t("onboarding:flow.continue")}</PrimaryCta>
                </div>
                <div>
                  <button type="button" className="co-onb-link mt-1" onClick={() => setForm(true)}>
                    {t("onboarding:flow.connect.addAnother")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2.5">
                  <OAuthButtons oauth={oauth} />
                </div>
                <div>
                  <div className="co-onb-or">
                    <span>{t("onboarding:flow.or", "or")}</span>
                  </div>
                </div>
                <div>
                  <button type="button" className="co-provider-btn" onClick={() => setForm(true)}>
                    <Icon name="mail" size={16} />
                    <span className="flex-1 text-left">{t("onboarding:flow.connect.imap")}</span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                </div>
                <AnimatePresence>
                  {oauth.busy && (
                    <motion.p
                      className="mt-2 text-sm text-ink-faint"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      {t("onboarding:flow.connect.waitingHint")}
                    </motion.p>
                  )}
                </AnimatePresence>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Stagger>
  );
}
