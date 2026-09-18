---
name: frontend-philosophy
description: Repository-led frontend implementation principles for consistent, accessible, understandable, and resilient user interfaces
---

# Frontend Philosophy

## Objective

Build and modify user interfaces that fit the product already being built.

The repository's established design language, component system, interaction patterns, content conventions, and accessibility approach are the primary authority. Do not impose a personal visual style, a generic “modern SaaS” aesthetic, or a new design system unless the task explicitly requires it.

A successful frontend change:

- Solves the user's task clearly and reliably.
- Reuses existing patterns and components where they fit.
- Preserves visual, behavioral, and semantic consistency.
- Works across supported devices, input methods, states, and assistive technologies.
- Introduces the smallest amount of new UI complexity necessary.

## When to Use

Use this skill for:

- Building or modifying frontend UI.
- Adding forms, flows, navigation, dialogs, menus, tables, empty states, loading states, and errors.
- Styling, layout, responsive behavior, animations, and interaction changes.
- Reviewing frontend changes for consistency, usability, and accessibility.

## Repository Discovery Comes First

Before planning UI architecture or implementing it, identify the existing feature owner and required behavioral delta. Inspect its components, relevant callers, state owner, and extension points. Reuse established evidence; inspect missing or changed facts rather than repeating research.

Look for:

- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, README files, architecture notes, and frontend-specific documentation.
- Design-system documentation, Storybook stories, component catalogs, visual-regression tests, and Figma links when available.
- Shared components, layout primitives, tokens, theme variables, icon libraries, typography rules, and utility conventions.
- Existing implementations of the same or closely related interaction.
- Form, validation, loading, empty, error, permission-denied, and destructive-action patterns.
- Existing accessibility utilities, lint rules, testing conventions, and browser-support requirements.

Follow the nearest applicable local convention. Reuse an existing component or pattern when it serves the same user need without forcing a misleading abstraction.

Record the existing owner/path, required change, preserved contracts, and any necessary new UI with a concrete justification. A paragraph or bullets in the existing plan or task context suffice; no separate artifact, schema, tool, or approval ceremony is needed. Separate explicit user requirements, preserved contracts, and demonstrated correctness, security, accessibility, or integrity needs from optional enhancements. Related-work links are context, not automatic scope. Original user requirements remain authoritative: an agent-authored plan cannot silently expand them.

Do not:

- Add a new dependency, design token, icon set, font, component primitive, animation library, or styling approach without a concrete need and repository-context justification.
- Create a parallel component system because an existing component is imperfect.
- Change product-wide visual language incidentally while completing a local feature.
- Copy a pattern mechanically when its semantics or interaction model do not fit the task.

## Decision Order

When making a frontend decision, apply this order:

1. **User task**
   - What is the user trying to accomplish?
   - What information, action, confirmation, or recovery path do they need?
2. **Existing product pattern**
   - Is there an established component or flow for this task?
   - Does the surrounding screen establish conventions that should be preserved?
3. **Semantic and accessible implementation**
   - Can native HTML semantics provide the correct behavior?
   - Does the interaction work with keyboard, pointer, touch, zoom, and assistive technology?
4. **Responsive and state-complete behavior**
   - Does it remain understandable at supported viewport sizes and in all meaningful states?
5. **Visual refinement**
   - Use existing tokens and styling conventions to support hierarchy, readability, and comprehension.
   - Add visual novelty only when explicitly requested or demonstrably appropriate to the product.

## Universal Interaction Principles

### Clarity and Visibility of System Status

Keep users informed about meaningful system state in a timely, understandable way.

Provide appropriate feedback for:

- Loading, progress, saving, success, failure, and offline or degraded states.
- Actions that take time or run asynchronously.
- Changes that are applied immediately versus changes that require explicit saving.
- Disabled or unavailable actions, including the reason when it is not obvious.

Do not use animation, color, or transient notifications as the only way to communicate essential state.

### Consistency and Recognition

Use the same control, label, icon, terminology, placement, and interaction model for the same concept unless there is a meaningful reason not to.

Prefer recognition over recall:

- Make options, constraints, current state, and next actions visible when needed.
- Do not require users to memorize hidden shortcuts, prior values, terminology, or multi-step state.
- Use familiar platform and product conventions before inventing a new interaction.

Consistency with an existing product pattern is generally more valuable than a locally “better-looking” alternative.

### User Control and Safe Recovery

Users should be able to understand the consequence of an action and recover from ordinary mistakes.

For consequential actions:

- Make the action and its effect clear before commitment.
- Prevent predictable mistakes with constraints, sensible defaults, previews, and inline guidance.
- Use confirmation proportionately; do not add confirmation dialogs for harmless or easily reversible actions.
- Provide undo, cancellation, back navigation, draft preservation, or recovery where feasible.
- Make destructive actions visually and semantically distinct according to repository conventions.

Errors must explain what happened, what the user can do next, and whether entered work was preserved.

### Content, Hierarchy, and Progressive Disclosure

Prioritize the information and action needed for the current task.

- Establish a clear primary action when one exists.
- Group related information and controls by user intent, not implementation structure.
- Use headings, labels, spacing, and layout to communicate hierarchy.
- Show essential information directly; reveal advanced, infrequent, or contextual detail progressively.
- Use concise, concrete language that matches the product's existing voice.
- Do not rely on placeholder text as the sole label or instruction for an input.

Do not add decoration, density, whitespace, motion, or visual effects merely to make a screen feel more “designed.” Each should improve hierarchy, comprehension, feedback, or brand expression.

### Accessibility and Input Independence

Build interactions that do not depend on a single sensory or input mode.

- Prefer native semantic elements such as `button`, `a`, `input`, `label`, `select`, and headings when they match the interaction.
- Use ARIA only to provide semantics that native HTML cannot provide; ARIA does not repair incorrect interaction behavior.
- Ensure every interactive element has an accessible name and a visible, usable focus state.
- Preserve logical keyboard order. Manage focus deliberately in dialogs, menus, popovers, and dynamic content.
- Do not hide focused controls behind sticky UI, overlays, or other author-created content.
- Provide a non-drag alternative for drag interactions unless dragging is essential.
- Ensure pointer targets meet repository standards and accessibility requirements. As a baseline, WCAG 2.2 AA defines a 24 by 24 CSS-pixel minimum target size or sufficient spacing, with specified exceptions.
- Do not communicate status, errors, required fields, selection, or meaning through color alone.
- Respect `prefers-reduced-motion`; motion must not be required to understand or operate the interface.
- Ensure hover-revealed content can be reached, read, and dismissed without trapping pointer or keyboard users.
- Test meaningful paths with keyboard-only navigation and at increased browser zoom.

### Responsive and Resilient Layout

Implement the behavior the product supports, rather than treating a desktop screenshot as the entire interface.

- Preserve task completion at supported widths, zoom levels, text scaling, and content lengths.
- Avoid clipping, overlap, inaccessible off-screen controls, horizontal scrolling for ordinary page content, and layout shifts that interrupt interaction.
- Design for loading, empty, error, permission, partial-data, and long-content states—not only the populated happy path.
- Keep DOM and visual order aligned unless there is a compelling accessibility-tested reason not to.
- Use responsive patterns already present in the repository before introducing a new breakpoint strategy or mobile-specific interaction.

## Component Reuse and Extension

Use components as behavior-and-accessibility contracts, not merely visual wrappers.

Before adding a component:

- Search for an existing primitive or composite component that fits the semantic role and interaction.
- Reuse it directly when possible.
- Compose existing primitives when the task represents a new, coherent pattern.
- Prefer a compatible extension of the current feature owner for the required delta; it need not benefit unrelated consumers. Preserve public APIs and defaults.
- Keep one-off feature-specific composition local when generalization would add speculative API surface.

Avoid shallow abstractions:

- Avoid wrappers that merely rename or forward props. A small presentational component can still own a meaningful semantic, visual, accessibility, or interaction boundary without deep business logic. A new component is not necessarily a new product design.
- Avoid interacting workflow flags that create unrelated modes, not legitimate binary props such as disabled or expanded.
- Use local extraction or separate compositions for genuinely different workflows, semantics, or interaction models; reuse does not require a mega-component. Different loading, error, retry, or completion states alone do not justify parallel widgets.
- Keep product policy, validation rules, and state transitions out of scattered presentational components when they require consistent behavior across the product.

### Domain State Is Not a Widget Catalog

Preserve internal distinctions needed for correctness and recovery, including stage-specific retries. Project user-meaningful feedback from the existing state owner rather than mirroring domain state into a new UI source of truth. Simplifying presentation must not erase retry limits, partial successes, or failure distinctions that the operation relies on.

### React Composition, When Applicable

Start with props and local composition. Existing `children`, named slots, and render-functions are valid extension points; render-functions are useful when supplying data to consumers. Preserve these APIs and defaults rather than replacing them to satisfy a preferred pattern.

Introduce a provider, compound-component API, or generic state/actions/meta interface only when concrete current coordination needs justify the extra contract. Decoupling logic from presentation does not require a provider or interchangeable backends. Optimize understandable behavior, not zero conditionals; composition alone does not make invalid states impossible.

Honor the repository's React version. `useContext` is supported; do not incidentally migrate it, `forwardRef`, or other established APIs. React 19 guidance is not authorization to break React 18 compatibility.

Concepts informed by Vercel composition-patterns v1.0.0, revision `a5343bd997c4cc4d8bf2ca61021bdc74b4d6c9d5`, `skills/composition-patterns/{SKILL,AGENTS}.md` (scoped metadata: license MIT, author vercel; no full upstream notice supplied). This is fresh Workcell guidance, not copied snippets. See also React's [before using context](https://react.dev/learn/passing-data-deeply-with-context#before-you-use-context), [useContext](https://react.dev/reference/react/useContext), and [forwardRef](https://react.dev/reference/react/forwardRef) references.

## Implementation Fit

Validate the plan against real component APIs and callers. Implement the smallest integrated representative UI behavior before multiplying variants or generalizing, then complete the remaining required behavior; do not stop at scaffolding or require a new user checkpoint. Simplify incidental structure within approved scope, but report concrete material architecture, scope, or API conflicts rather than silently expanding the task.

Reassess parallel widgets, providers, generic interfaces, duplicated state, and growing test matrices against the requirement and a simpler viable alternative, not a line-count cap.

## Motion and Visual Styling

Visual decisions must support the repository's existing system and the user's task.

- Use existing tokens for color, spacing, typography, elevation, radii, and motion where available.
- Preserve established contrast, hierarchy, density, and responsive conventions.
- Use motion to communicate causality, orientation, feedback, or continuity—not as ambient decoration.
- Keep motion interruptible where appropriate and compatible with reduced-motion preferences.
- Do not add gradients, textures, shadows, custom fonts, unusual layouts, or decorative effects unless the repository or task calls for them.
- When no visual guidance exists, choose a restrained, readable, accessible implementation that is easy for the codebase to evolve.

## State Completeness Checklist

For each meaningful interaction, consider whether these states need an implementation:

- Default and available.
- Hover, focus-visible, active, selected, and disabled where applicable.
- Loading or pending.
- Success or completed.
- Empty or no-results.
- Validation error, server error, and recovery.
- Permission-denied, unavailable, or unsupported where applicable.
- Long labels, translated text, missing optional data, and narrow viewports.

Implement only the states relevant to the feature, but do not leave a known user path undefined.

## Verification

Before completing frontend work:

- Confirm the implementation follows applicable repository guidance and reuses the appropriate existing primitives.
- Verify the primary user task and relevant failure or recovery path.
- Check keyboard navigation, focus visibility, and focus behavior for dynamic UI.
- Check loading, error, empty, disabled, and destructive states when applicable.
- Check responsive behavior at the project’s supported viewport sizes and increased zoom.
- Verify color contrast and non-color indicators where relevant.
- Respect reduced-motion preferences for added or modified motion.
- Run the repository's relevant linting, type checking, tests, Storybook checks, or visual-regression workflow when available.
- Use available rendered verification for the integrated behavior; report its absence or limitations rather than implying that static checks prove UX.
- Test distinct contracts at their natural boundary: retry limits/backoff, each required pipeline stage (for example URL, transfer, finalize), idempotency, and preserved successes belong at the pipeline layer; UI tests protect user feedback, recovery, and accessibility. Avoid exhaustive render permutations without deleting correctness coverage.

## What Not To Do

- Do not impose a personal aesthetic or a generic AI-generated visual style.
- Do not replace established patterns because a new component looks more modern.
- Do not introduce visual novelty at the expense of comprehension, consistency, performance, or accessibility.
- Do not implement custom interactive widgets when native controls or existing accessible primitives fit.
- Do not ship only a polished happy path while omitting loading, errors, empty states, or keyboard behavior.
- Do not use vague visual terms such as “make it premium,” “make it pop,” or “make it modern” as implementation criteria without repository or task-specific meaning.
