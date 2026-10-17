import { useTranslation } from "react-i18next";
import { Item, PrimaryCta, Stagger, StepHeader } from "../flowParts";

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <Stagger className="flex flex-col">
      <StepHeader title={t("onboarding:flow.welcome.title")} body={t("onboarding:flow.welcome.body")} />
      <Item className="mt-8">
        <PrimaryCta onClick={onNext}>{t("onboarding:flow.welcome.cta")}</PrimaryCta>
      </Item>
    </Stagger>
  );
}
