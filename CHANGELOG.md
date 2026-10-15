# Changelog

## 0.1.0

- First release: visualize a `.sqlproj` as an interactive ERD.
- Tables with columns, data types, nullability, PK / FK / UQ badges, identity and defaults.
- Views (with column types resolved from their source tables), functions and stored procedures
  (with parameters) as toggleable layers, connected by dependency lines.
- Collapsible objects, schema filter, search, details pane, open-source-on-double-click.
- `Layers` and `Graph` layouts, drag to rearrange (layout is remembered per project), SVG export.
- Live reload when project scripts change.
