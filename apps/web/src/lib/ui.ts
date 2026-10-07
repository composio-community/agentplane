import { create } from "zustand";

type Theme = "light" | "dark";

type UiState = {
  theme: Theme;
  dialog: { kind: "add-project" } | { kind: "new-thread"; projectId: string } | null;
  palette: boolean;
};

export const useUi = create<UiState>(() => ({
  theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  dialog: null,
  palette: false,
}));

export function setPalette(open: boolean): void {
  useUi.setState({ palette: open });
}

export function openDialog(dialog: NonNullable<UiState["dialog"]>): void {
  useUi.setState({ dialog });
}

export function closeDialog(): void {
  useUi.setState({ dialog: null });
}

export function toggleTheme(): void {
  const theme: Theme = useUi.getState().theme === "dark" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("agentplane-theme", theme);
  } catch {
    // Storage can be unavailable (private windows); the toggle still works.
  }
  useUi.setState({ theme });
}
