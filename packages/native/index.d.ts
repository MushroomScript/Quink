export interface SelectionEvent {
  text: string;
  x: number;
  y: number;
}
export function onSelection(callback: (event: SelectionEvent) => void): void;
export function grabSelection(): void;
