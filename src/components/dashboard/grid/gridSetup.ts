import {
  CellStyleModule,
  ClientSideRowModelModule,
  ExternalFilterModule,
  ModuleRegistry,
  PaginationModule,
  QuickFilterModule,
  RowApiModule,
  RowStyleModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";

/*
 * AG Grid 36 (Community). Only the modules the dashboard grids use are registered (smaller bundle than
 * AllCommunityModule). ValidationModule adds console warnings for misconfiguration in development only.
 * Theming uses the Theming API (themeQuartz.withParams), so no AG Grid CSS files are imported.
 */
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  QuickFilterModule,
  ExternalFilterModule,
  PaginationModule,
  TooltipModule,
  CellStyleModule,
  RowStyleModule,
  RowApiModule,
  ...(process.env.NODE_ENV !== "production" ? [ValidationModule] : []),
]);

/** Seller Shield brand on the Quartz theme: white rows, cream header, deep green accent. */
export const gridTheme = themeQuartz.withParams({
  accentColor: "#2f4a37",
  backgroundColor: "#ffffff",
  foregroundColor: "#263226",
  textColor: "#263226",
  borderColor: "#eee7d9",
  headerBackgroundColor: "#faf7f0",
  headerTextColor: "#6b705f",
  headerFontWeight: 600,
  headerFontSize: 12,
  fontFamily: "inherit",
  fontSize: 13,
  rowHoverColor: "#f8f4ea",
  selectedRowBackgroundColor: "#eef3ee",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  headerRowBorder: true,
  rowBorder: { color: "#f1ebdf" },
  columnBorder: false,
  cellHorizontalPadding: 12,
  rowHeight: 60,
  headerHeight: 40,
});
