"""The two hours PDFs, laid out from timesheet rows (rendering: app.services.pdf_report)."""
from collections import defaultdict
from datetime import date, datetime, timedelta

from app.services.pdf_report import Section, Stat, render_report
from app.utils.timezone import now_in_org_tz, to_org_tz


def fmt_hours(h: float) -> str:
    whole = int(h)
    minutes = int(round((h - whole) * 60))
    if minutes == 60:
        whole, minutes = whole + 1, 0
    return f"{whole}h {minutes:02d}m"


def _local_hhmm(iso: str | None) -> str:
    if not iso:
        return "-"
    return to_org_tz(datetime.fromisoformat(iso.rstrip("Z"))).strftime("%H:%M")


def _created_line() -> str:
    return f"created   {now_in_org_tz().strftime('%Y-%m-%d %H:%M')}"


def _day_status(row: dict) -> str:
    if row.get("no_time_out"):
        return "No time out"
    if row["late"]:
        return "Late"
    return "On time" if row["first_in"] else "No clock-in"


def employee_hours_pdf(rows: list[dict], summary: list[dict], start_day: date, end_day: date,
                       department: str | None, detail_for_one_employee: bool) -> bytes:
    """Every employee's total hours; with `detail_for_one_employee` (a ?user_id
    was given) also that employee's day-by-day breakdown."""
    regular = sum(p["hours"] for p in summary)
    overtime = sum(p["ot_hours"] for p in summary)
    total = sum(p["total_hours"] for p in summary)

    meta = [f"period    {start_day.isoformat()} to {end_day.isoformat()}"]
    if department:
        meta.append(f"dept      {department}")
    meta.append(_created_line())

    sections, stats = [], []
    if summary:
        data = [[p["user_name"], p["employee_code"], p["department"], p["days_worked"],
                 fmt_hours(p["hours"]), fmt_hours(p["ot_hours"]), fmt_hours(p["total_hours"])] for p in summary]
        data.append(["Total", "", "", sum(p["days_worked"] for p in summary),
                     fmt_hours(regular), fmt_hours(overtime), fmt_hours(total)])
        sections.append(Section("Hours by employee", ["EMPLOYEE", "ID", "DEPARTMENT", "DAYS", "REGULAR", "OT", "TOTAL"], data,
                                [48, 20, 38, 14, 22, 16, 22], total_row=True, align_right=(3, 4, 5, 6)))
        stats = [Stat("Employees", str(len(summary)), accent=True),
                 Stat("Regular hours", fmt_hours(regular)),
                 Stat("OT hours", fmt_hours(overtime)),
                 Stat("Total hours", fmt_hours(total)),
                 Stat("Missing time-outs", str(sum(p["days_without_time_out"] for p in summary)))]

    if detail_for_one_employee and rows:
        detail = [[r["date"], _local_hhmm(r["first_in"]), _local_hhmm(r["last_out"]),
                   fmt_hours(r["hours"]), fmt_hours(r["ot_hours"]), _day_status(r)] for r in rows]
        sections.append(Section(f"Daily breakdown: {rows[0]['user_name']}", ["DATE", "TIME IN", "TIME OUT", "REGULAR", "OT", "STATUS"],
                                detail, [30, 26, 26, 28, 24, 32], align_right=(3, 4)))

    return render_report(title="Employee hours", slug="hours-report", meta=meta, stats=stats, sections=sections,
                         empty_message="No attendance in this period.",
                         notes=["Days with a missed time-out are flagged and excluded from hours until corrected."] if summary else (),
                         footer_note="Ala Eh! attendance report")


def _department_section(summary: list[dict]) -> Section | None:
    departments: dict[str, dict] = {}
    for p in summary:
        d = departments.setdefault(p["department"] or "Unassigned", {"people": 0, "days": 0, "hours": 0.0, "ot": 0.0})
        d["people"] += 1
        d["days"] += p["days_worked"]
        d["hours"] += p["hours"]
        d["ot"] += p["ot_hours"]
    if len(departments) <= 1:
        return None
    rows = [[name, d["people"], d["days"], fmt_hours(d["hours"]), fmt_hours(d["ot"]), fmt_hours(d["hours"] + d["ot"]),
             fmt_hours((d["hours"] + d["ot"]) / d["people"])]
            for name, d in sorted(departments.items(), key=lambda kv: -(kv[1]["hours"] + kv[1]["ot"]))]
    return Section("Hours by department", ["DEPARTMENT", "PEOPLE", "DAYS", "REGULAR", "OT", "TOTAL", "PER PERSON"], rows,
                   [46, 17, 16, 26, 22, 26, 27], align_right=(1, 2, 3, 4, 5, 6))


def _hours_per_day_chart(rows: list[dict], start_day: date, span: int):
    by_day: dict[str, float] = defaultdict(float)
    for r in rows:
        by_day[r["date"]] += r["total_hours"]
    days = [start_day + timedelta(days=i) for i in range(span)]
    return [(d.strftime("%m-%d"), round(by_day.get(d.isoformat(), 0.0), 2)) for d in days]


def hours_summary_pdf(rows: list[dict], summary: list[dict], start_day: date, end_day: date,
                      department: str | None, search: str) -> bytes:
    """A summary of the hours worked in the range: per employee, per department and per day."""
    regular = sum(p["hours"] for p in summary)
    overtime = sum(p["ot_hours"] for p in summary)
    late_days = sum(p["late_days"] for p in summary)
    missed_timeouts = sum(p["days_without_time_out"] for p in summary)
    span = (end_day - start_day).days + 1
    period = start_day.isoformat() if span == 1 else f"{start_day.isoformat()} to {end_day.isoformat()}"
    meta = [f"period    {period}  ({span} day{'s' if span != 1 else ''})",
            f"dept      {department}" if department else "dept      all departments"]
    if search:
        meta.append(f"search    {search}")
    meta.append(_created_line())

    stats = [Stat("Employees", str(len(summary))), Stat("Total hours", fmt_hours(regular + overtime), accent=True),
             Stat("Regular", fmt_hours(regular)), Stat("Overtime", fmt_hours(overtime)), Stat("Late days", str(late_days)),
             Stat("Missing time-outs", str(missed_timeouts))]
    chart = _hours_per_day_chart(rows, start_day, span) if summary and 1 < span <= 62 else None

    sections = []
    dept_section = _department_section(summary)
    if dept_section:
        sections.append(dept_section)
    if summary:
        emp_rows = [[p["user_name"], p["employee_code"] or "", p["department"] or "", p["days_worked"], fmt_hours(p["hours"]),
                     fmt_hours(p["ot_hours"]), fmt_hours(p["total_hours"]), p["late_days"]] for p in summary]
        emp_rows.append(["Total", "", "", "", fmt_hours(regular), fmt_hours(overtime), fmt_hours(regular + overtime), late_days])
        sections.append(Section("Hours by employee", ["EMPLOYEE", "ID", "DEPARTMENT", "DAYS", "REGULAR", "OT", "TOTAL", "LATE"], emp_rows,
                                [42, 22, 31, 12, 22, 17, 22, 12], total_row=True, align_right=(3, 4, 5, 6, 7)))

    return render_report(title="Hours summary", slug="hours-summary", meta=meta, stats=stats if summary else (), sections=sections,
                         empty_message="No hours were recorded in this period.", chart=chart, chart_title="Hours per day",
                         notes=["Unpaid break time is not counted. A shift that is still open counts up to now.",
                                "Days with a missed time-out are flagged and excluded from hours until corrected."] if summary else (),
                         footer_note="Ala Eh! hours summary")
