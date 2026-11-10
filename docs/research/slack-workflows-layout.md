# Slack Workflows gallery

Measured November 10, 2026 in an authenticated Slack web workspace on the free plan. The observations below come from screenshots, accessibility roles, DOM geometry, and computed styles in the running browser.

| Surface | Shipped rendering |
| --- | --- |
| Navigation | Agents & tools → Workflows opens Templates. Managed by you has a separate list and empty state. New Workflow appears in the header and is gated by the workspace plan. |
| Banner | The introduction spans the 1,253px results pane. Its text and illustration sit in a centered 968px flex container with a 20px gap. The banner measured 294px high. Its heading used 22px type. |
| Featured templates | A collapsible section contains clickable cards. In the wider pane three cards fit across. The first measured 311 × 116px, with 12px padding, an 8px radius, and 15px text on a 22.5px line. |
| Width rule | The result wrapper computed to `min(968px, 100% - 32px)`. A second measurement produced a 711px results pane, a 679px inner row, and a 333px featured card. |
| All templates | Below featured templates, Slack shows a connector filter and a multi-column results grid. The free workspace exposed the catalog and gated template setup. |

The full-width surface belongs to the banner. The catalog centers its contents and reduces the number of cards per row as the pane narrows. Useful inspection anchors include `.p-explorer_results__contained-result`, `.p-explorer_actions`, and `.p-explorer_workflow_template_grid__cell`. The banner's CSS module class names were build-specific.

## Space adaptation

Space aligns the title, tabs, banner copy, template grid, and publication list with shared responsive gutters. The banner fills the pane. The list uses its available inner width and the cards reflow at pane widths of 790px and 540px. The illustrated request, routing, and confirmation tiles are original to Space. The featured section contains the working IT Help Request template. The published list exposes the existing start action.

## Interaction evidence

Collapsing Featured templates in the live Slack workspace hid that row of cards only; All templates remained visible. REA inspection of Slack’s shipped browse-workflows-tabbed-view and use-workflow-templates-explorer bundles identified conditional All, Templates and Managed by you views, internal support for Your templates, and the dismissible introductory banner. REA evidence: `ev_d3a36eb08a37bcf6340d507abd4a83b0c89162fe71744fa563615e60e36c086d`. A conditional view in the bundle is not proof that every plan shows it.

The free workspace did not permit publishing. Slack documents template selection → Set Up → customization → publish in [Use a workflow template](https://slack.com/help/articles/31449260577043-Build-a-workflow--Use-a-workflow-template), and editing from Managed by you followed by Publish Changes in [Edit and manage your workflows](https://slack.com/help/articles/360054495774-Edit-and-manage-your-workflows).

Space uses All for runnable published workflows, Templates for discovery, and Managed by you for editing and republishing. IT Help Request is the single supported template. Its step preview, two channel selectors, and confirmation after claiming are Space implementations. The gallery uses Slack’s measured content width; feature availability and the workflow execution engine are Space’s own.
