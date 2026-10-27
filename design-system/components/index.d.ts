import type * as React from 'react';

export type IconName = 'check' | 'alert' | 'info' | 'error' | 'marker' | 'upload' | 'file' | 'search' | 'lock' | 'chevron' | 'duplicate' | 'inbox' | 'send' | 'report' | 'building' | 'split' | 'arrow' | 'clock';
export interface IconProps { name: IconName; size?: number; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai'; size?: 'sm' | 'md'; icon?: IconName }
export declare function Button(props: ButtonProps): React.ReactElement;

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> { label: string; hint?: string; error?: string; mono?: boolean }
export declare function TextField(props: TextFieldProps): React.ReactElement;

export type DocumentStatus = 'uploaded' | 'splitting' | 'extracting' | 'proposed' | 'needs-review' | 'duplicate' | 'manual' | 'failed' | 'approved' | 'locked';
export interface StatusBadgeProps { status: DocumentStatus; children?: React.ReactNode }
export declare function StatusBadge(props: StatusBadgeProps): React.ReactElement;

export interface ConfidenceProps { value: number; compact?: boolean }
export declare function Confidence(props: ConfidenceProps): React.ReactElement;

export interface MoneyProps { amount: number; currency?: string; locale?: string; className?: string }
export declare function Money(props: MoneyProps): React.ReactElement;

export interface AiValueProps { label: string; value?: React.ReactNode; children?: React.ReactNode; state?: 'proposed' | 'edited' | 'approved'; confidence?: number; source?: string; mono?: boolean; active?: boolean }
export declare function AiValue(props: AiValueProps): React.ReactElement;

export interface AiSuggestionProps { title: string; eyebrow?: string; reasons?: string[]; confidence?: number; acceptLabel?: string; changeLabel?: string; onAccept?: () => void; onChange?: () => void; children?: React.ReactNode }
export declare function AiSuggestion(props: AiSuggestionProps): React.ReactElement;

export interface AskBarProps { id?: string; label?: string; placeholder?: string; defaultValue?: string; answer?: string; citations?: string[] }
export declare function AskBar(props: AskBarProps): React.ReactElement;

export interface DataTableColumn<Row> { key: string; header: string; align?: 'left' | 'right'; mono?: boolean; muted?: boolean; render?: (row: Row) => React.ReactNode }
export interface DataTableProps<Row extends { id: string | number }> { columns: DataTableColumn<Row>[]; rows: Row[]; selectedId?: Row['id']; caption?: string }
export declare function DataTable<Row extends { id: string | number }>(props: DataTableProps<Row>): React.ReactElement;

export interface DropZoneProps { title?: string; hint?: string; accept?: string; over?: boolean; onFiles?: React.ChangeEventHandler<HTMLInputElement> }
export declare function DropZone(props: DropZoneProps): React.ReactElement;

export interface ViewerRegion { id: string; x: number; y: number; w: number; h: number; tag?: string; active?: boolean }
export interface DocumentViewerProps { regions?: ViewerRegion[]; scanning?: boolean; toolbar?: React.ReactNode; label?: string; children?: React.ReactNode }
export declare function DocumentViewer(props: DocumentViewerProps): React.ReactElement;

export type SidebarItem = { group: string } | { label: string; icon: IconName; href?: string; count?: number; ai?: boolean; current?: boolean };
export interface SidebarProps { company?: { name: string; ico: string }; items: SidebarItem[] }
export declare function Sidebar(props: SidebarProps): React.ReactElement;

export interface NoticeProps { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: React.ReactNode }
export declare function Notice(props: NoticeProps): React.ReactElement;

export interface EmptyStateProps { title: string; icon?: IconName; action?: React.ReactNode; children?: React.ReactNode }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;

export declare function formatAmount(amount: number, locale?: string): string;
export declare function confidenceLevel(value: number): 'high' | 'medium' | 'low';

declare global { interface Window { iVAT: { Icon: typeof Icon; Button: typeof Button; TextField: typeof TextField; StatusBadge: typeof StatusBadge; Confidence: typeof Confidence; Money: typeof Money; AiValue: typeof AiValue; AiSuggestion: typeof AiSuggestion; AskBar: typeof AskBar; DataTable: typeof DataTable; DropZone: typeof DropZone; DocumentViewer: typeof DocumentViewer; Sidebar: typeof Sidebar; Notice: typeof Notice; EmptyState: typeof EmptyState; formatAmount: typeof formatAmount; confidenceLevel: typeof confidenceLevel } } }
