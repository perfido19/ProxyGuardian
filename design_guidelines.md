# Design Guidelines: VPS Proxy Management Dashboard

## Design Approach

**Selected Approach:** Design System - Material Design influenced, optimized for data-dense server administration interfaces

**Justification:** This is a utility-focused, information-dense application for technical users managing critical infrastructure. The design prioritizes efficiency, clarity, and rapid information access over visual experimentation.

**Key Design Principles:**
1. **Information Hierarchy First** - Critical status information immediately visible
2. **Scan-ability** - Dense data presented in digestible chunks
3. **Action Clarity** - Destructive actions (unban, service restart) clearly distinguished
4. **Responsive Data Tables** - Mobile-friendly collapsible views for IP lists and logs
5. **Real-time Feedback** - Visual indicators for live data updates

---

## Core Design Elements

### A. Typography

**Font Family:** 
- Primary: 'Inter' or 'Roboto' from Google Fonts - excellent readability for technical data
- Monospace: 'JetBrains Mono' or 'Fira Code' for logs, IP addresses, configuration files

**Type Scale:**
- Page Headers: text-2xl font-bold (Dashboard sections)
- Card Headers: text-lg font-semibold 
- Data Labels: text-sm font-medium uppercase tracking-wide
- Body Text: text-base
- Table Data: text-sm
- Log Lines: text-xs font-mono
- Timestamps: text-xs opacity-70

**Hierarchy Rules:**
- Service status cards use large numbers (text-3xl font-bold) for key metrics
- IP addresses and technical identifiers always in monospace
- Section headers with subtle bottom borders for clear separation

### B. Layout System

**Spacing Primitives:** 
Use Tailwind units of **2, 4, 6, 8** as core spacing (p-2, p-4, gap-6, m-8)
- Tight spacing (2): Table cell padding, icon-text gaps
- Standard spacing (4): Card padding, form field spacing
- Section spacing (6): Between card groups, sidebar items
- Page spacing (8): Main content padding, section dividers

**Grid Structure:**
- Sidebar Navigation: Fixed 64 (w-64) on desktop, collapsible drawer on mobile
- Main Content Area: Full width with max-w-7xl container, px-4 lg:px-8
- Dashboard Cards: grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6
- Data Tables: Full width within container, horizontal scroll on mobile

**Container Strategy:**
- Dashboard overview: Multi-column card grid (4 columns on large screens)
- Detail pages: Single column max-w-4xl for forms, full width for tables
- Log viewer: Full width, fixed height with internal scroll

### C. Component Library

#### Navigation
**Sidebar Navigation (Primary):**
- Fixed left sidebar (hidden on mobile, toggle button top-left)
- Navigation items with icons + text labels
- Active state: Subtle background, left border accent
- Grouped sections: Dashboard, Services, Firewall, Logs, Configuration
- Logout button pinned to bottom

**Mobile Navigation:**
- Hamburger menu (top-left)
- Slide-out drawer overlay
- Close on item selection

#### Dashboard Cards (Status Metrics)
**Service Status Cards:**
- Compact card with icon, service name, status badge
- Large metric number (connections, banned IPs count)
- Small trend indicator or secondary stat
- Action button (Restart/Stop/Start) bottom-right
- Grid layout: 4 columns desktop, 2 tablet, 1 mobile

**Stats Cards:**
- Icon + Label + Large Number format
- Examples: Total Bans (24h), Active Connections, Blocked Countries
- Subtle border, rounded corners (rounded-lg)

#### Data Tables
**IP Ban Table (Primary Use Case):**
- Sortable columns: IP Address, Ban Time, Reason, Jail, Actions
- Row actions: Unban button (destructive action styling)
- Pagination (show 25/50/100 entries)
- Search/filter bar above table
- Responsive: Stack columns on mobile with expand/collapse per row

**Table Design:**
- Striped rows for readability (alternate row background)
- Monospace font for IP addresses
- Compact padding (p-2 for cells)
- Fixed header on scroll
- Empty state: Centered icon + message

#### Forms & Inputs
**Whitelist/Blacklist Management:**
- Label above input (text-sm font-medium mb-2)
- Input fields with clear borders, rounded-md
- Textarea for multi-line entries (countries, IPs)
- Helper text below inputs (text-xs)
- Submit buttons: Primary action right-aligned
- Cancel/Reset: Secondary styling left-aligned

**Input Groups:**
- Country selector: Multi-select dropdown with search
- IP input: Monospace font, validation feedback
- File upload: Drag-drop zone for config files

#### Log Viewer
**Real-time Log Display:**
- Fixed height container (h-96) with internal scroll
- Monospace text on dark background (code-like appearance)
- Auto-scroll to bottom (with toggle to pause)
- Line numbers on left
- Color-coded by log level: ERROR, WARN, INFO
- Search/filter controls above viewer
- Download log button

#### Status Indicators
**Service Status Badges:**
- Pill-shaped badges (rounded-full px-3 py-1)
- States: Running, Stopped, Error, Restarting
- Icon + text combination

**Real-time Indicators:**
- Pulsing dot for live data feeds
- Last updated timestamp (text-xs, faded)

#### Action Buttons
**Primary Actions:**
- Rounded buttons (rounded-md px-4 py-2)
- Icons + text labels for clarity
- Loading states with spinner replacement

**Destructive Actions:**
- Restart Service, Unban IP: Warning styling
- Confirmation modal before execution
- Clear labeling: "Confirm Restart Nginx"

#### Modals & Overlays
**Configuration Editor:**
- Full-screen overlay on mobile
- Large modal (max-w-4xl) on desktop
- Code editor with syntax highlighting (textarea with monospace)
- Save/Cancel buttons fixed at bottom
- Validation feedback before save

**Confirmation Dialogs:**
- Centered modal (max-w-md)
- Clear question + action description
- Cancel (subtle) + Confirm (prominent) buttons

### D. Animations

**Minimal Animations Only:**
- Page transitions: None (instant navigation for speed)
- Dropdown menus: Simple slide-down (duration-200)
- Modal open/close: Fade + scale (duration-300)
- Loading spinners: Smooth rotation
- Table row hover: Subtle background transition (duration-150)

**NO Animations For:**
- Dashboard card appearance
- Log line additions
- Metric updates
- Status badge changes (instant feedback preferred)

---

## Page-Specific Layouts

### Dashboard (Home)
**Layout:**
- Top: Welcome header + current server time + quick stats bar
- Main: 4-column grid of service status cards
- Below: 2-column layout → Recent bans table (left 2/3) + Top blocked countries (right 1/3)
- Bottom: Quick actions panel (restart all services, view all logs)

### Services Management
**Layout:**
- List view: Each service (Nginx, Fail2ban, MariaDB) as expandable card
- Expanded view shows: Status, Uptime, Version, Resource usage, Action buttons
- Configuration quick-edit for each service

### Firewall Rules
**Layout:**
- Tabbed interface: Countries | ASN | ISP | User-Agents | IP Whitelist
- Each tab: Table with Add/Edit/Delete actions
- Import/Export buttons for bulk management

### Logs Viewer
**Layout:**
- Tab navigation: Nginx Access | Nginx Error | Fail2ban | ModSecurity
- Full-width log viewer with controls above
- Live toggle + Auto-refresh interval selector
- Download and clear log buttons

### Configuration Files
**Layout:**
- File tree sidebar (left 1/4)
- Code editor (right 3/4)
- Save button with validation
- Backup/restore functionality

---

## Images

**No hero images or decorative photography** - This is a technical dashboard.

**Icon Usage:**
- Service icons: Nginx logo, database icon, shield for Fail2ban
- Status icons: Check, X, warning triangle, refresh spinner
- Action icons: Play/stop/restart, trash, download, edit
- Use icon library: Heroicons (outline style for most, solid for status indicators)

---

## Responsive Behavior

**Breakpoints:**
- Mobile: < 768px → Sidebar collapses, cards stack, tables scroll horizontally
- Tablet: 768px - 1024px → 2-column grids, visible sidebar
- Desktop: > 1024px → Full multi-column layouts, fixed sidebar

**Mobile Priorities:**
- Service status cards first
- Recent bans table (simplified columns)
- Quick action buttons
- Hamburger menu for all navigation

---

## Accessibility & Usability

**Technical User Optimizations:**
- Keyboard shortcuts for common actions (display in help modal)
- Command palette (Cmd+K) for quick navigation
- Copy-to-clipboard for IP addresses (click to copy)
- Export functionality for all tables (CSV/JSON)
- Confirmation on all destructive actions
- Clear error messages with resolution steps

**Language:** All interface text in Italian as requested