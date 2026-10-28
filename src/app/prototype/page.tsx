import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  VisualPrototype,
  prototypeScreens,
  type PrototypeScreen,
} from "@/components/visual-prototype";

function isPrototypeScreen(value: unknown): value is PrototypeScreen {
  return typeof value === "string" && prototypeScreens.includes(value as PrototypeScreen);
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("prototype");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    robots: { index: false, follow: false },
  };
}

export default async function PrototypePage({
  searchParams,
}: PageProps<"/prototype">) {
  const requested = (await searchParams).screen;
  const screen = isPrototypeScreen(requested) ? requested : "overview";
  return <VisualPrototype screen={screen} />;
}
