"""Build docs/E2E_TEST_PACK.pdf, the manual end-to-end tester checklist.

Black and yellow Ala Eh! theme: black cover, header bar with logo, yellow ID column,
drawn Pass/Fail checkboxes, contents page with real page numbers, pilot sheets and sign-off.

    .\\backend\\.venv\\Scripts\\python.exe docs/build_e2e_test_pack.py
"""
import tempfile
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table,
                                TableStyle, Flowable, PageBreak, CondPageBreak, NextPageTemplate, KeepTogether)
from reportlab.pdfgen import canvas as rl_canvas

W, H = letter
BLACK = colors.HexColor('#111111')
INK = colors.HexColor('#1B1B1B')
YEL = colors.HexColor('#FFC20E')
YEL_T = colors.HexColor('#FFF4CC')
YEL_D = colors.HexColor('#E0A800')
GREY = colors.HexColor('#5E5E58')
LINE = colors.HexColor('#D8D6CE')
ZEBRA = colors.HexColor('#F7F6F1')
ROOT = Path(__file__).resolve().parent
LOGO = str(ROOT.parent / 'frontend' / 'public' / 'logo.png')
MX = 0.55*inch
CW = W-2*MX
OUT = str(ROOT / 'E2E_TEST_PACK.pdf')


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def P(t, **k):
    base = dict(fontName='Helvetica', fontSize=8.2,
                leading=10.4, textColor=INK)
    base.update(k)
    return ParagraphStyle('x', **base)


S_CELL = P('')
S_B = P('', fontName='Helvetica-Bold')
S_STEP = P('', fontSize=7.8, leading=10, textColor=colors.HexColor('#3A3A36'))
S_TH = P('', fontName='Helvetica-Bold',
         fontSize=8.2, textColor=YEL, leading=10)
S_ID = P('', fontName='Helvetica-Bold', fontSize=8.6, textColor=BLACK)
S_SUB = P('', fontSize=8.6, leading=11.5, textColor=GREY)
S_H2 = P('', fontName='Helvetica-Bold', fontSize=13, leading=16,
         textColor=BLACK, spaceBefore=12, spaceAfter=6)

# --------------------------------------------------------------------------- test cases
# (id, title, [steps], expected)   steps are numbered automatically when rendered
SECTIONS = [
    ("A", "Sign-in, roles and sessions",
     "Who can get in, what each role sees, and when a session must end.", [
         ("A01", "Admin signs in", ["Open the app address.", "Enter the admin email and password, click Sign in."],
          "The Dashboard opens (\"Today at a glance\"). The side menu shows Dashboard, Reports, Employees, Enroll, Departments, Review, Records."),
         ("A02", "Wrong password", ["Enter the admin email with a wrong password."],
             "A clear error appears, nothing opens, and the page does not say whether the email exists."),
         ("A03", "Login lockout", ["Enter a wrong password 5 times in a row for the same email.", "Then enter the CORRECT password."],
             "After the 5th failure the account is locked for about 15 minutes: the correct password is also refused with a \"try again in N minutes\" message."),
         ("A04", "Reload keeps the session", ["Sign in, open any page, press F5."],
             "The same page reloads still signed in. The sign-in screen does not flash."),
         ("A05", "Sign out", ["Click sign out.", "Press the browser Back button."],
             "The sign-in screen shows. Back does not show any protected page or data."),
         ("A06", "Protected pages need sign-in", ["In a private window, open /admin/employees directly."],
             "You are sent to the sign-in screen."),
         ("A07", "Staff role is restricted", ["Create a STAFF user (see B07).", "Sign in as that user.", "Type /admin/employees in the address bar."],
             "Only \"Records\" (their own attendance) is available. The admin address redirects back to their own page."),
         ("A08", "Operator role", ["Sign in as an OPERATOR."],
             "Menu shows only Dashboard and Records. The kiosk can be opened. /admin/employees is not available."),
         ("A09", "Deactivated user is signed out", ["Sign in as a STAFF user in one browser.", "In another, an admin deactivates that user (Employees > Edit).", "In the first browser, click any page."],
             "The staff browser is signed out on its next action and cannot sign in again."),
         ("A10", "Password change ends other sessions", ["Sign in as a user in two browsers.", "An admin changes that user's password.", "In the old browsers, click around."],
             "Old sessions are signed out; the new password works."),
         ("A11", "Tokens are not readable by scripts", ["Sign in. In browser developer tools open Application > Local Storage and Cookies."],
             "No access or refresh token in Local Storage. The refresh cookie is marked HttpOnly (and Secure on HTTPS)."),
     ]),
    ("B", "Departments and employees",
     "Set-up data that every later test depends on.", [
         ("B01", "Create a day department", ["Departments > Add department.", "Name \"Day Shift\", 08:00 - 17:00, break 12:00 - 13:00. Save."],
          "Saved and listed with its hours and break."),
         ("B02", "Create an overnight department", ["Add department \"Night Shift\", start 22:00, end 06:00, break 02:00 - 03:00. Save."],
             "Saved. The list shows an \"Ends next day\" marker."),
         ("B03", "Break must fit the shift", ["Edit the night department and set the break to 12:00 - 13:00 (outside the shift)."],
             "The save is refused (or the break is moved inside the shift) with a clear message. It is never saved silently wrong."),
         ("B04", "Rotating shifts", ["Add department \"Rotating\" with shifts Morning 06:00-14:00, Afternoon 14:00-22:00, Night 22:00-06:00."],
             "Saved with all three shifts. Equal start/end times or duplicate shift names are refused."),
         ("B05", "Edit and delete a department", ["Edit a department's hours, save.", "Delete a department with no employees, confirm."],
             "Edit is saved. Delete asks for confirmation and removes it. Both appear in the Audit log (see G11)."),
         ("B06", "Create an employee with a face", ["Enroll > New employee. Fill name, email, initial password, Employee ID, department, position.", "Continue to face capture (see section C)."],
             "The employee is created and appears under Employees."),
         ("B07", "Create a STAFF login", ["Employees > Add employee (or Enroll), role STAFF, with an email and password."],
             "Created. The row shows the role badge Staff."),
         ("B08", "Duplicate Employee ID", ["Create a second employee with an Employee ID already in use."],
             "Refused with a clear message; no second record."),
         ("B09", "Edit employee in one save", ["Employees > Edit an employee.", "Change the role AND the password in the same save."],
             "One save succeeds; both changes apply; the employee's old sessions end."),
         ("B10", "Kiosk device account", ["Create a user with role KIOSK."],
             "A password is required. The row shows \"Device account\" and has no face-enrollment link."),
         ("B11", "Search employees", ["Type part of a name in \"Search employees\"."],
             "The list narrows as you type; clearing the box restores it."),
         ("B12", "Deactivate and reactivate", ["Edit an employee, switch off Active, save.", "Switch it back on."],
             "While off, the employee cannot sign in and the kiosk does not record them. Back on, both work again."),
         ("B13", "Delete: history is kept", ["Delete an employee WITH attendance records, confirm.", "Delete one WITHOUT records."],
             "With records: the employee is archived (stays listed as deactivated, face data erased, attendance kept). Without: removed completely."),
     ]),
    ("C", "Face enrollment",
     "Requires a camera. On a LAN address use http://localhost or HTTPS, never plain http://192.168... Turn the sound on for C09 to C11.", [
         ("C01", "Enroll a new employee", ["Enroll > New employee, fill details.", "Tick the biometric consent box.", "Follow the on-screen poses until all poses are captured."],
          "Each good pose is counted. At the end a success message shows and the employee shows as enrolled in Employees."),
         ("C02", "Consent is required", ["Start enrolling without ticking consent."],
             "Capture does not start until consent is recorded (once per employee)."),
         ("C03", "Poor frames are rejected, not spammed", ["During capture cover your face, then turn away, then blur the camera with a hand."],
             "A reason is shown for each rejection. Rejected frames are not re-sent every second; there is a short pause."),
         ("C04", "Duplicate face is refused", ["Try to enroll the SAME person as a second, different employee."],
             "Refused: the face is already enrolled as someone else. No second set of samples is stored."),
         ("C05", "Enroll an existing employee", ["Enroll > Existing employee, search by name, pick one, capture samples."],
             "Samples are added to that employee. KIOSK device accounts do not appear in the search."),
         ("C06", "Start over / reset samples", ["During capture choose Start over and confirm.", "Optionally reset an employee's samples from Employees."],
             "Only that employee's samples are removed; others are untouched."),
         ("C07", "Camera needs a secure address", ["Open the app at http://<LAN-IP> (not localhost, not https) and open Enroll or the kiosk."],
             "A clear \"Camera needs HTTPS\" message is shown instead of a blank camera."),
         ("C08", "Camera recovery", ["While the camera is running, unplug the webcam, wait, plug it back."],
             "The camera restarts by itself within a few seconds; no page reload needed."),
         ("C09", "Pose sequence", ["Start capture for a new employee and note each pose banner in order."],
             "Poses come one at a time: look straight ahead, turn slightly left, turn slightly right, tilt chin up, tilt chin down, straight ahead and smile. A banner shows the current pose number and an arrow for the direction."),
         ("C10", "Chin up / chin down is judged correctly", ["On the tilt chin up pose, look straight ahead and wait.", "Then tilt the chin up a small amount.", "Repeat for chin down."],
             "A straight face is NOT accepted as chin up or chin down. A small tilt in the right direction is accepted. A face with no visible chin is shown as not ready, not captured."),
         ("C11", "Voice guidance in enrollment", ["With Sound on, move through the poses.", "Press the Sound button to turn it off, then on again."],
             "Each pose is spoken (\"Turn slightly left\", etc.), with a chime and \"Captured\" between poses and \"All done\" at the end. With Sound off, the chimes and voice stop. If a recording is missing, the browser voice speaks instead."),
         ("C12", "Left and right are calibrated per person", ["Enroll a person whose head sits slightly off-centre or tilted.", "Do the left and right poses with a normal small turn."],
             "Left is accepted only for a real turn left and right only for a turn right, for this person. The same turn is never accepted for both."),
     ]),
    ("D", "Kiosk check-in",
     "Run on the real kiosk device. Use enrolled test employees. Record who tried what in the notes.", [
         ("D01", "Open the kiosk", ["Sign in as admin or operator and open the kiosk (/kiosk)."],
          "Full-screen camera with no admin menu. The session is now kiosk-locked."),
         ("D02", "Idle screen wakes", ["Leave the kiosk alone until the idle screen shows.", "Walk up to the camera (or touch the screen)."],
             "The idle screen (logo, greeting, clock) wakes and the scan view returns."),
         ("D03", "Enrolled employee clocks in", ["Stand in the guide area, click Start scan and blink naturally."],
             "Name and photo are shown, a confirmation chime plays, \"Time in\" is spoken, and a Time in is recorded (visible in Records and on the Dashboard)."),
         ("D04", "No blink = no record", ["Click Start scan and stare without blinking until it finishes."],
             "The kiosk asks the person to blink / shows a liveness message and says \"blink\". NOTHING is recorded."),
         ("D05", "Immediate rescan", ["Right after D03, scan again."],
             "A cooldown message appears; no second record."),
         ("D06", "Rescan within the verification window", ["Wait past the cooldown but stay within 2 minutes, scan again."],
             "The kiosk confirms the earlier punch (verified) and does not add another."),
         ("D07", "Unknown person", ["Have someone who is NOT enrolled scan."],
             "\"Not recognised\"-style message (also spoken). Nothing recorded. The attempt appears in Review (section H)."),
         ("D08", "Time out and the lunch break", ["Use the Time in / Time out and Morning / Afternoon / Overtime buttons around the break time.", "Scan with Time out before lunch, Time in after lunch."],
             "Morning out and Afternoon in are recorded with the right labels. The server corrects a wrong choice that conflicts with the day's record."),
         ("D09", "Guide zone", ["Scan while standing far to the side of the camera.", "Scan again standing too far from the camera."],
             "\"Move into the circle\" / \"Move closer\" is shown (and spoken once, not repeatedly). Nothing recorded."),
         ("D10", "Deactivated employee", ["Deactivate a test employee, then scan with them."],
             "Not recorded; no attendance is created."),
         ("D11", "Only one scan at a time", ["Click Start scan several times quickly."],
             "Only one check-in runs; the direction buttons are disabled while it works. One record at most."),
         ("D12", "Connection lost", ["While on the kiosk, turn off Wi-Fi / unplug the network.", "Try a scan.", "Restore the network."],
             "An offline banner shows and scanning pauses. A scan in progress says \"Not recorded - check the connection and try again\". After the network returns, scanning resumes by itself and the user is still signed in."),
         ("D13", "Kiosk clock", ["Set the tablet's own clock wrong (optional), look at the kiosk clock."],
             "The kiosk shows organisation time (server time), not the tablet's clock."),
         ("D14", "Leave the kiosk with the password", ["Click Admin.", "Enter a WRONG password, then the right one, click Unlock."],
             "Wrong: \"Wrong password. Try again.\" (5 wrong in a minute: asked to wait). Right: the admin portal opens and stays open."),
         ("D15", "Locked means locked", ["While on the kiosk, type /admin or /admin/employees in the address bar.", "Press Back / reload."],
             "You are returned to the kiosk every time. No admin page opens without unlocking."),
         ("D16", "Kiosk device account", ["Sign in with a KIOSK device account on the tablet."],
             "It goes straight to the kiosk. There is NO Admin button, only a note that an admin signs the device out by deactivating the account."),
         ("D17", "Kiosk survives a reload", ["On a locked kiosk press F5."],
             "It reloads still locked and still signed in."),
         ("D18", "Scan rate limit", ["Trigger many scans in under a minute (for example repeatedly from a script or fast clicks over several minutes)."],
             "After the limit (about 60 check-ins per minute) a \"too many attempts, retry in N seconds\" message appears; normal use is not affected."),
         ("D19", "Voice prompts on the kiosk", ["Complete a successful scan, a no-blink scan, an unknown scan, and a scan too far from the camera.", "Leave the kiosk in a failing state for 30 seconds."],
             "Each outcome is spoken after the chime (time in or out, blink, not recognised, move closer or into the circle, one person only). Repeated prompts are spaced out (not every frame). Speech stops when the scan view closes."),
         ("D20", "Several faces in view", ["Have two people stand in the frame and start a scan."],
             "The kiosk asks for one person at a time. Nothing is recorded for either person."),
         ("D21", "Debug overlay is absent in production", ["On the production server open the kiosk and Enroll, then add ?debug=1 to the address."],
             "No face boxes or debug panel appear (at most \"The server sent no debug data\"). Requesting /api/recognition/debug-detect returns 404."),
     ]),
    ("E", "Spoofing and look-alike attempts",
     "These must FAIL to record attendance. Do each several times and fill the tables in section L. Every spoof that is recorded is a Blocker.", [
         ("E01", "Photo on a phone screen", ["Show an enrolled employee's photo full-screen on a phone to the kiosk."],
          "Nothing is recorded. Pass or fail comes from what you observe on the deployment camera, not from the automated tests."),
         ("E02", "Printed photo", ["Hold a printed, clear photo of an enrolled employee in front of the camera."],
             "Nothing is recorded. Record every attempt in L3."),
         ("E03", "Photo plus someone else blinking", ["Hold the employee's photo while another person (not enrolled) sits next to it and blinks in view."],
             "Nothing is recorded: the blink must come from the same face that was recognised."),
         ("E04", "Video of the employee", ["Play a short video of an enrolled employee blinking on a phone."],
             "Do not assume this is blocked. Record every attempt and whether attendance was recorded. Any recorded spoof is a Blocker; repeat in representative screen and camera conditions."),
         ("E05", "Look-alikes", ["Have relatives or look-alike colleagues (both enrolled) scan, each in turn."],
             "Each person is recognised as themselves, never as the other. An ambiguous scan is held for review instead of guessed."),
         ("E06", "Mask, hat, glasses, bad light", ["Scan with a cap, glasses on/off, in dim light and with a bright window behind."],
             "Either recognised correctly or asked to retry. NEVER recorded as a different person."),
         ("E07", "Possible spoof is flagged", ["Run E01 or E02 and open Review > Possible spoof."],
             "The attempt is listed as a possible spoof (when the anti-spoof model scores it), with no attendance created."),
     ]),
    ("F", "Shifts, lateness and work days",
     "Use Records > Manual entry to create punches at exact times. Use your own test employees.", [
         ("F01", "Normal day, on time", ["Day Shift employee: manual Time in 08:05, Time out 17:05."],
          "Not late. Hours = about 8 (lunch break subtracted)."),
         ("F02", "Late arrival", ["Day Shift employee, new day: Time in 08:40 (grace is 15 minutes unless changed)."],
             "Marked late. With the 15-minute grace the late minutes shown are about 25 (40 minutes after the 08:00 start, less the grace)."),
         ("F03", "Overnight shift is ONE work day", ["Night Shift employee: manual Time in 22:00 on day 1, Time out 06:05 on day 2."],
             "One work day dated day 1. Hours about 7 (8 minus the 02:00-03:00 break). Not late. The out time is marked as the next date."),
         ("F04", "Rotating shift is not late for its own shift", ["Rotating employee: Time in 14:05 (Afternoon shift)."],
             "NOT late (it matches the 14:00 shift). Time in 08:40 for the 06:00 shift would be late."),
         ("F05", "History is not rewritten", ["Note an employee's late minutes.", "Edit that employee's department start time.", "Open the same old day again."],
             "The old day still shows the original late minutes."),
         ("F06", "Shift end rule", ["After the shift end, try a normal Time in at the kiosk without choosing Overtime."],
             "Not recorded as a regular clock-in; overtime must be chosen explicitly."),
         ("F07", "Once-per-slot rule", ["Record Morning in, then try Morning in again the same day."],
             "The second one is refused or shown as already recorded."),
     ]),
    ("G", "Records, corrections and reports",
     "Compare the numbers between Records and Reports for the same dates.", [
         ("G01", "Records tabs and dates", ["Records > Timesheet, then Scan log.", "Try Today, Yesterday, This week, This month."],
          "Both tabs load; the rows change with the date range; times are in organisation time."),
         ("G02", "Manual entry", ["Records > Manual entry. Search and pick an employee, set a date/time, save."],
             "The punch appears at exactly that organisation-local time and is in the Audit log."),
         ("G03", "No future punches", ["Manual entry with a time more than 5 minutes in the future."],
             "Refused with a clear message."),
         ("G04", "Correct a punch", ["Edit a punch: change type, session, time and note."],
             "Saved; late/early and the work day are recalculated; the Audit log shows before and after."),
         ("G05", "Delete a punch", ["Delete a punch, confirm."],
             "Removed after confirmation; lateness moves to the day's next first Time in; Audit log entry exists."),
         ("G06", "Paging", ["Open a range with many records."],
             "Shows \"Showing X-Y of N\" with working next/previous. Nothing is silently cut off."),
         ("G07", "Staff sees only their own", ["Sign in as STAFF, open Records."],
             "Only their own attendance is listed."),
         ("G08", "Reports: employee hours", ["Reports > Employee hours for a range with known punches."],
             "Hours match Records (lunch break subtracted); late counts match; overnight days grouped by work date."),
         ("G09", "CSV export", ["Export CSV for the range and open it in Excel.", "Add a note beginning with = (for example =1+1) to a punch first."],
             "CSV downloads with columns including Work date and Late (min). The = note shows as text and is not executed as a formula."),
         ("G10", "PDF per employee", ["Download an employee's PDF from Reports."],
             "A readable PDF with that employee's days and hours."),
         ("G11", "Audit log", ["Reports > Audit log. Filter by action and by date. Page through."],
             "Shows who did what and when for logins, account changes, department changes, corrections and deletions. Filters and paging work; passwords are never shown."),
     ]),
    ("H", "Review queue",
     "Uncertain scans are kept here instead of being guessed.", [
         ("H01", "Uncertain scans appear", ["Run D07 (unknown person) and a poor-light scan.", "Open Review."],
          "Snapshots show with filters (Needs review, Unknown face, Low confidence, Ambiguous, No blink, Possible spoof, Matched, Resolved)."),
         ("H02", "Add as sample", ["On a genuine unrecognised snapshot of an enrolled employee, click Add as sample and choose them."],
             "Becomes a new face sample for that employee and shows as Added as sample."),
         ("H03", "Spoof snapshots cannot enroll", ["Open a Possible spoof snapshot."],
             "There is no \"Add as sample\" button; enrolling from it is refused."),
         ("H04", "Dismiss without double clicks", ["Click Dismiss quickly twice on one snapshot."],
             "It is dismissed once; no error; it moves to Resolved."),
         ("H05", "Load more", ["Scroll to the end of a long list and use Load more."],
             "Further items append without losing the current ones."),
     ]),
    ("I", "Live dashboard",
     "Use two browsers: one on the kiosk, one on the Dashboard.", [
         ("I01", "Instant update", ["Keep the Dashboard open.", "Do a successful check-in on the kiosk."],
          "The scan appears on the Dashboard within a second or two, without refreshing."),
         ("I02", "Connection indicator", ["Watch the Dashboard connection chip.", "Restart the backend (or drop the network briefly)."],
             "The chip shows disconnected, then reconnects by itself; new scans appear again."),
         ("I03", "Day counts", ["Compare the \"Today at a glance\" numbers with Records for today."],
             "Counts of present, late and on site match the records."),
     ]),
    ("J", "Data protection and destructive actions",
     "Run last on a test copy. Never on live data.", [
         ("J01", "Clear all data protections", ["Employees > Clear all data.", "Try with a wrong password, then right password but without typing DELETE, then both correct."],
          "Refused until the password and the word DELETE are correct. Afterwards admins, operators and kiosk accounts and the Audit log are KEPT."),
         ("J02", "Rate limit on sign-in", ["Submit many sign-in attempts from one device within a minute (about 10)."],
             "A \"too many attempts, try again in N seconds\" message appears."),
         ("J03", "Photos need sign-in", ["Copy an employee photo link and open it in a private window."],
             "Not shown without signing in."),
         ("J04", "Snapshot retention", ["Check the SNAPSHOT_RETENTION_DAYS settings.", "Open Review and look for old snapshots."],
             "Defaults are 90 days for matched snapshots and 30 days for others. Purging happens when snapshots are created or the Review list is opened (not a scheduled job); older snapshots are gone afterwards."),
     ]),
    ("K", "Installation and operations",
     "For the person who runs the server. See the README (Production).", [
         ("K01", "HTTPS address works", ["On the kiosk tablet open https://<SITE_ADDRESS>."],
          "Loads with a normal lock icon (after Caddy's certificate is trusted on the tablet for LAN installs)."),
         ("K02", "Camera works on the tablet", ["Open the kiosk at the https address and allow the camera."],
             "Camera starts. Kiosk shows the video."),
         ("K03", "Health endpoint", ["Open https://<SITE_ADDRESS>/api/health."],
             "Shows {\"ok\": true, \"database\": \"ok\"}."),
         ("K04", "All services healthy", ["Run docker compose ps."],
             "caddy, frontend, backend and db are Up/healthy; backup is Up. No service keeps restarting."),
         ("K05", "Restart recovery", ["Restart the backend container while the kiosk is open."],
             "The kiosk stays signed in and works again within about a minute."),
         ("K06", "Reboot recovery", ["Restart the server machine."],
             "All services come back by themselves; the kiosk works without anyone logging in on the server."),
         ("K07", "Daily backup", ["Look in the backups folder the day after start-up."],
             "A dated database dump exists; older ones beyond retention are removed."),
         ("K08", "Restore rehearsal", ["On a SPARE machine run deploy/restore.sh with a backup file."],
             "Employees, faces and attendance come back. (Also confirm FACE_DATA_KEY is stored safely: without it face data cannot be read.)"),
         ("K09", "Upgrade keeps data", ["Pull a new version, run docker compose up -d --build."],
             "Migrations run automatically; existing employees and records are intact."),
         ("K10", "Anti-spoof models load", ["Check the backend log after start-up (SPOOF_MODE auto or enforce)."],
             "Both anti-spoof models in backend/models load. If none can load in production, the backend refuses to start rather than running without them."),
         ("K11", "Voice recordings are served", ["Open https://<SITE_ADDRESS>/voice/kiosk.already_recorded.mp3 or any clip in frontend/public/voice."],
             "The audio file plays. A missing clip is replaced by the browser voice, never by silence."),
         ("K12", "No other site on the same ports", ["On the server run docker ps and list which containers publish ports 80 and 443."],
             "Only this system's caddy publishes 80 and 443. No stopped or dev copy of the stack is left behind."),
     ]),
]

pages = {}


class Marker(Flowable):
    def __init__(s, key): Flowable.__init__(s); s.key = key
    def wrap(s, a, b): return (0, 0)
    def draw(s): pages[s.key] = s.canv.getPageNumber()


class PassFail(Flowable):
    def wrap(s, a, b): s.w = a; return (a, 30)

    def draw(s):
        c = s.canv
        c.setLineWidth(0.9)
        c.setStrokeColor(BLACK)
        c.setFont('Helvetica', 7.8)
        c.setFillColor(INK)
        for i, l in enumerate(('Pass', 'Fail')):
            y = 19-i*14
            c.rect(2, y, 9, 9, fill=0)
            c.drawString(15, y+1.5, l)


class Badge(Flowable):
    """Section header: yellow letter badge + black title bar"""
    def __init__(s, letter_, title): Flowable.__init__(
        s); s.l = letter_; s.t = title

    def wrap(s, a, b): s.w = a; return (a, 0.52*inch)

    def draw(s):
        c = s.canv
        h = 0.52*inch
        c.setFillColor(BLACK)
        c.roundRect(0, 0, s.w, h, 5, fill=1, stroke=0)
        c.setFillColor(YEL)
        c.roundRect(0, 0, 0.6*inch, h, 5, fill=1, stroke=0)
        c.rect(0.4*inch, 0, 0.2*inch, h, fill=1, stroke=0)
        c.setFillColor(BLACK)
        c.setFont('Helvetica-Bold', 24)
        c.drawCentredString(0.3*inch, h/2-8.5, s.l)
        c.setFillColor(colors.white)
        c.setFont('Helvetica-Bold', 15)
        c.drawString(0.78*inch, h/2-5.3, s.t)


def section_head(letter_, title, sub):
    return [CondPageBreak(2.4*inch), Marker(letter_), Spacer(1, 6), Badge(letter_, title), Spacer(1, 5),
            Table([[Paragraph(esc(sub), S_SUB)]], colWidths=[CW], style=TableStyle([
                ('LINEBEFORE', (0, 0), (0, 0), 2.5, YEL), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1)])),
            Spacer(1, 7)]


def th(t): return Paragraph(esc(t), S_TH)


def base_style(n, hdr=True, id_col=False):
    st = [('BACKGROUND', (0, 0), (-1, 0), BLACK), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('LINEBELOW', (0, 1), (-1, -1), 0.5,
           LINE), ('BOX', (0, 0), (-1, -1), 0.6, LINE),
          ('LEFTPADDING', (0, 0), (-1, -1),
           6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
          ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
          ('LINEBELOW', (0, 0), (-1, 0), 2, YEL)]
    for r in range(2, n, 2):
        st.append(('BACKGROUND', (0, r), (-1, r), ZEBRA))
    return st


def test_table(tests):
    cw = [0.5*inch, 2.5*inch, 2.2*inch, 0.72*inch]
    cw.append(CW-sum(cw))
    rows = [[th('ID'), th('Test and steps'), th(
        'Expected result'), th('Result'), th('Notes')]]
    for tid, title, steps, exp in tests:
        left = [Paragraph(esc(title), S_B), Spacer(
            1, 2)]+[Paragraph(esc(f'{n}. {x}'), S_STEP) for n, x in enumerate(steps, 1)]
        rows.append([Paragraph(tid, S_ID), left, Paragraph(
            esc(exp), S_CELL), PassFail(), Spacer(1, 34)])
    t = Table(rows, colWidths=cw, repeatRows=1)
    st = base_style(len(rows))
    st += [('BACKGROUND', (0, 1), (0, -1), YEL_T), ('LINEAFTER', (0, 1),
                                                    (0, -1), 1.5, YEL), ('LINEBEFORE', (4, 0), (4, -1), 0.5, LINE)]
    t.setStyle(TableStyle(st))
    return t


def simple_table(head, rows, cw, bold_first=True, zebra=True, extra=None, pad=None):
    data = [[th(h) for h in head]]
    for r in rows:
        data.append([Paragraph(esc(c), S_B if (i == 0 and bold_first) else S_CELL)
                    if isinstance(c, str) else c for i, c in enumerate(r)])
    t = Table(data, colWidths=cw, repeatRows=1)
    st = base_style(len(data))
    if extra:
        st += extra
    t.setStyle(TableStyle(st))
    return t

# ---------------- canvas / templates ----------------


class NumCanvas(rl_canvas.Canvas):
    def __init__(s, *a, **k): rl_canvas.Canvas.__init__(s,
                                                        *a, **k); s._saved = []

    def showPage(s): s._saved.append(dict(s.__dict__)); s._startPage()

    def save(s):
        n = len(s._saved)
        for st in s._saved:
            s.__dict__.update(st)
            if s._pageNumber > 1:
                s.setFont('Helvetica-Bold', 8.5)
                s.setFillColor(YEL)
                s.drawRightString(W-MX, H-0.31*inch,
                                  'Page %d of %d' % (s._pageNumber, n))
            rl_canvas.Canvas.showPage(s)
        rl_canvas.Canvas.save(s)


def body_page(c, doc):
    c.saveState()
    c.setFillColor(BLACK)
    c.rect(0, H-0.56*inch, W, 0.56*inch, fill=1, stroke=0)
    c.setFillColor(YEL)
    c.rect(0, H-0.62*inch, W, 0.06*inch, fill=1, stroke=0)
    c.drawImage(LOGO, MX, H-0.5*inch, 0.42*inch, 0.42*inch, mask='auto')
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(MX+0.55*inch, H-0.33*inch, 'ALA EH! ATTENDANCE SYSTEM')
    c.setFillColor(colors.HexColor('#BDBDB5'))
    c.setFont('Helvetica', 9)
    c.drawString(MX+0.55*inch+137, H-0.33*inch, '|   End-to-End Test Pack')
    c.setStrokeColor(YEL)
    c.setLineWidth(1.2)
    c.line(MX, 0.52*inch, W-MX, 0.52*inch)
    c.setFillColor(GREY)
    c.setFont('Helvetica', 7.6)
    c.drawString(
        MX, 0.36*inch, 'Tester copy. Tick Pass or Fail for every test and write what you saw in Notes.')
    c.drawRightString(
        W-MX, 0.36*inch, 'Ala Eh! Food Products  |  27 October 2026')
    c.restoreState()


def cover_page(c, doc):
    c.saveState()
    c.setFillColor(BLACK)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(YEL)
    c.rect(0, H-0.3*inch, W, 0.3*inch, fill=1, stroke=0)
    c.rect(0, 0, W, 0.3*inch, fill=1, stroke=0)
    # diagonal accent
    c.setFillColor(colors.HexColor('#1C1C1C'))
    p = c.beginPath()
    p.moveTo(0, 0.3*inch)
    p.lineTo(W, 0.3*inch)
    p.lineTo(W, 3.9*inch)
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    c.drawImage(LOGO, W/2-1.35*inch, H-4.25*inch,
                2.7*inch, 2.7*inch, mask='auto')
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 46)
    c.drawCentredString(W/2, H-5.35*inch, 'END-TO-END')
    c.setFillColor(YEL)
    c.drawCentredString(W/2, H-6.15*inch, 'TEST PACK')
    c.setFillColor(YEL)
    c.rect(W/2-0.5*inch, H-6.5*inch, 1*inch, 3, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont('Helvetica', 15)
    c.drawCentredString(
        W/2, H-6.95*inch, 'Ala Eh! Facial Recognition Attendance System')
    # stat boxes
    stats = [('106', 'TEST CASES'), ('11', 'AREAS'),
             ('3', 'PILOT SHEETS'), ('1', 'SIGN-OFF')]
    bw = 1.55*inch
    gap = 0.14*inch
    x0 = (W-(4*bw+3*gap))/2
    y = H-8.25*inch
    for i, (n, l) in enumerate(stats):
        x = x0+i*(bw+gap)
        c.setStrokeColor(YEL)
        c.setLineWidth(1)
        c.setFillColor(colors.HexColor('#1A1A1A'))
        c.roundRect(x, y, bw, 0.78*inch, 5, fill=1, stroke=1)
        c.setFillColor(YEL)
        c.setFont('Helvetica-Bold', 24)
        c.drawCentredString(x+bw/2, y+0.38*inch, n)
        c.setFillColor(colors.HexColor('#CFCFC8'))
        c.setFont('Helvetica-Bold', 7.5)
        c.drawCentredString(x+bw/2, y+0.14*inch, l)
    c.setFillColor(colors.HexColor('#BDBDB5'))
    c.setFont('Helvetica', 9.5)
    c.drawCentredString(
        W/2, H-8.85*inch, 'Includes accuracy pilot sheets, defect log and go-live sign-off')
    c.drawCentredString(
        W/2, H-9.1*inch, 'Version: current release (voice-guided kiosk, live detection, chin-based poses, anti-spoof models)')
    c.setFillColor(YEL)
    c.setFont('Helvetica-Bold', 10)
    c.drawCentredString(W/2, H-9.5*inch, 'Prepared: 27 October 2026')
    c.restoreState()


def build(path):
    doc = BaseDocTemplate(path, pagesize=letter, title='Ala Eh! End-to-End Test Pack', author='Ala Eh! Food Products',
                          leftMargin=MX, rightMargin=MX, topMargin=0.85*inch, bottomMargin=0.7*inch)
    f = Frame(MX, 0.7*inch, CW, H-0.85*inch-0.7*inch, leftPadding=0,
              rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate('cover', frames=[Frame(0, 0, W, H)], onPage=cover_page),
                          PageTemplate('body', frames=[f], onPage=body_page)])
    s = [NextPageTemplate('body'), PageBreak()]
    # ---- section 0
    s += section_head('0', 'How to use this pack',
                      'Read this page before you start testing.')
    steps = [('1', 'Fill in the test environment table below, then prepare the test data. Do the sections in order: B, C and D build on each other.'),
             ('2', 'For every test follow the steps exactly and compare with Expected result. Tick Pass only if everything matches. Otherwise tick Fail.'),
             ('3', 'In Notes write what actually happened (message text, time, who tested). For every Fail add a line to the Defect log at the end.'),
             ('4', 'Sections E (spoofing) and L (accuracy pilot) are counted in attempts, not single pass/fail. Fill in the tables, do not skip the failures.'),
             ('5', 'Finish with the sign-off page. The system is ready only when the agreed pass rules on that page are met.')]
    s.append(simple_table(['Step', 'What to do'], [[a, b] for a, b in steps], [0.55*inch, CW-0.55*inch],
                          extra=[('BACKGROUND', (0, 1), (0, -1), YEL_T), ('LINEAFTER', (0, 1), (0, -1), 1.5, YEL)]))
    s.append(Paragraph('Result key and defect severity', S_H2))
    key = [('Pass', 'Behaviour matches the expected result exactly.'),
           ('Fail', 'Anything different, including a confusing or missing message. Write what you saw.'),
           ('Blocker', 'Wrong person recorded, attendance recorded for a spoof, data lost, or nobody can use the kiosk. Do not go live.'),
           ('Major', 'A feature does not work but there is a workaround (for example a report shows wrong hours).'),
           ('Minor', 'Cosmetic or wording problem, no effect on attendance records.')]
    t = simple_table(['Term', 'Meaning'], [list(k) for k in key], [1.0*inch, CW-1.0*inch],
                     extra=[('BACKGROUND', (0, 3), (0, 3), BLACK), ('BACKGROUND', (0, 4), (0, 4), YEL), ('BACKGROUND', (0, 5), (0, 5), colors.HexColor('#E6E4DA')),
                            ('LINEAFTER', (0, 1), (0, -1), 1.5, BLACK)])
    # colour Blocker text
    t._cellvalues[3][0] = Paragraph('Blocker', P(
        '', fontName='Helvetica-Bold', textColor=YEL))
    s.append(t)
    s.append(Paragraph('Test environment (fill in)', S_H2))
    items = [('Application address', 'Lighting at the kiosk'), ('Version / commit', 'Browser and version'), ('Server (machine, Docker or dev)', 'Test date(s)'),
             ('Kiosk device and screen size', 'Tester name'), ('Camera model and height from floor', 'Speaker / volume at the kiosk')]
    c4 = [1.55*inch, (CW-3.1*inch)/2, 1.55*inch, (CW-3.1*inch)/2]
    data = [[th('Item'), th('Value'), th('Item'), th('Value')]]
    for a, b in items:
        data.append([Paragraph(a, S_B), Spacer(1, 22), Paragraph(b, S_B), ''])
    t = Table(data, colWidths=c4, repeatRows=1)
    st = base_style(len(data))
    st += [('BACKGROUND', (0, 1), (0, -1), YEL_T), ('BACKGROUND', (2, 1), (2, -1), YEL_T), ('LINEAFTER', (0, 1), (0, -1), 0.8, LINE), ('LINEAFTER', (1, 0), (1, -1), 0.8, LINE), ('LINEAFTER', (2, 1), (2, -1), 0.8, LINE),
           ('BACKGROUND', (0, 2), (-1, -1), colors.white), ('BACKGROUND', (0, 1), (0, -1), YEL_T), ('BACKGROUND', (2, 1), (2, -1), YEL_T)]
    t.setStyle(TableStyle(st))
    s.append(t)
    s.append(PageBreak())
    # ---- prepare
    s.append(Paragraph('Test data and tools to prepare', P(
        '', fontName='Helvetica-Bold', fontSize=15, leading=18, spaceAfter=7)))
    prep = [('Accounts', 'One ADMIN, one OPERATOR, one STAFF and one KIOSK device account, each with a known password. Write them in the Notes of the first test (A01) only; do not leave real passwords in this document.'),
            ('Departments', '"Day Shift" 08:00-17:00 break 12:00-13:00; "Night Shift" 22:00-06:00 break 02:00-03:00; "Rotating" with Morning, Afternoon and Night shifts (see B01 to B04).'),
            ('Employees with faces', 'At least 5 enrolled test people: 2 on Day Shift, 1 Night, 1 Rotating, 1 more. Include 2 people who look alike if possible, one wearing glasses, one with a beard or different hair. Everyone gives consent.'),
            ('One person not enrolled',
             'Used for the unknown-person tests (D07, E03).'),
            ('Spoof material', 'A phone with a clear photo and a short video of one enrolled person, and a printed A5/A4 photo of the same person.'),
            ('Two devices', 'The kiosk device (with speakers on) and a second computer for the Dashboard (I01) and admin work.'),
            ('Network control', "A way to switch the kiosk's Wi-Fi off and on (D12)."),
            ('Safe copy', 'Run section J on a copy or a fresh install. Clearing data on the live system cannot be undone (backups only).'),
            ('Production-like server', 'Use a server with APP_ENV=production for D21, K10 and the spoof tests. A development server shows the debug overlay and is not representative.')]
    s.append(simple_table(['Prepare', 'Details'], [list(x) for x in prep], [1.5*inch, CW-1.5*inch],
                          extra=[('BACKGROUND', (0, 1), (0, -1), YEL_T), ('LINEAFTER', (0, 1), (0, -1), 1.5, YEL)]))
    s.append(Paragraph('Contents', S_H2))
    areas = [(l, t, str(len(ts))) for l, t, _, ts in SECTIONS]
    rows = [[a, b, c, str(pages.get(a, '-'))] for a, b, c in areas]
    rows.append(['L', 'Accuracy pilot sheets (genuine, wrong-person and spoof attempts)',
                'sheets', str(pages.get('L', '-'))])
    rows.append(['M', 'Defect log and sign-off',
                'sheets', str(pages.get('M', '-'))])
    s.append(simple_table(['Section', 'Area', 'Tests', 'Page'], rows, [0.8*inch, CW-2.5*inch, 0.85*inch, 0.85*inch],
                          extra=[('BACKGROUND', (0, 1), (0, -1), YEL_T), ('LINEAFTER', (0, 1), (0, -1), 1.5, YEL)]))
    s.append(PageBreak())
    # ---- test sections
    for i, (l, t, sub, tests) in enumerate(SECTIONS):
        s += section_head(l, t, sub)
        s.append(test_table(tests))
        s.append(Spacer(1, 10))
        if l in ('D',):
            s.append(PageBreak())
    # ---- L
    s.append(PageBreak())
    s += section_head('L', 'Accuracy pilot sheets',
                      'Automated tests cannot measure accuracy on your cameras. Fill these in during a pilot of one to two weeks. Counts matter more than impressions: record every attempt, including failures.')

    def blank_sheet(head, cw, n, rowh, label_rows=None, total=False):
        data = [[th(h) for h in head]]
        for i in range(n):
            lab = Paragraph(esc(label_rows[i]), S_B) if label_rows else ''
            data.append([lab]+['']*(len(head)-1))
        if total:
            data.append([Paragraph('TOTAL', S_B)]+['']*(len(head)-1))
        t = Table(data, colWidths=cw, repeatRows=1,
                  rowHeights=[None]+[rowh]*(len(data)-1))
        st = base_style(len(data))
        st += [('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
               ('LINEAFTER', (0, 0), (-2, -1), 0.5, LINE)]
        if total:
            st += [('BACKGROUND', (0, -1), (-1, -1), YEL),
                   ('LINEABOVE', (0, -1), (-1, -1), 1.2, BLACK)]
        t.setStyle(TableStyle(st))
        return t
    s.append(
        Paragraph('L1. Genuine attempts (enrolled people scanning themselves)', S_H2))
    s.append(Paragraph('Each person scans about 10 times on different days and in different light (morning, afternoon, evening, with and without glasses).', S_SUB))
    s.append(Spacer(1, 5))
    cw = [1.45*inch, 0.7*inch, 0.95*inch, 1.2*inch, 1.2*inch]
    cw.append(CW-sum(cw))
    s.append(blank_sheet(['Person', 'Attempts', 'Recognised correctly', 'Not recognised / asked to retry',
             'Recognised as the WRONG person', 'Notes'], cw, 10, 0.27*inch, total=True))
    s.append(Spacer(1, 5))
    s.append(Table([[Paragraph('<b>Calculate:</b> Correct rate = recognised correctly / attempts. False-reject rate = not recognised / attempts. <b>Wrong-person count must be 0.</b> One wrong-person record is a Blocker.', P('', fontSize=8, leading=10.5))]], colWidths=[CW],
                   style=TableStyle([('BACKGROUND', (0, 0), (-1, -1), YEL_T), ('LINEBEFORE', (0, 0), (0, 0), 3, YEL), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)])))
    s.append(CondPageBreak(3.4*inch))
    s.append(
        Paragraph('L2. Impostor attempts (people who must NOT be accepted)', S_H2))
    s.append(Paragraph(
        'Not enrolled people, and look-alikes of enrolled people, each try about 10 times.', S_SUB))
    s.append(Spacer(1, 5))
    cw2 = [2.1*inch, 0.8*inch, 1.0*inch, 1.1*inch]
    cw2.append(CW-sum(cw2))
    s.append(blank_sheet(['Person (not enrolled / look-alike of ...)', 'Attempts',
             'Rejected correctly', 'ACCEPTED (any name)', 'Notes'], cw2, 8, 0.27*inch, total=True))
    s.append(CondPageBreak(3.0*inch))
    s.append(Paragraph('L3. Spoof attempts', S_H2))
    s.append(Spacer(1, 2))
    s.append(blank_sheet(['Attack', 'Attempts', 'Blocked', 'RECORDED as attendance', 'Notes'], cw2, 5, 0.32*inch,
                         label_rows=['Photo on phone screen', 'Printed photo', 'Photo + another person blinking', 'Video of the employee blinking', 'Mask / photo with cut-out eyes']))
    s.append(Spacer(1, 8))
    s.append(Table([[Paragraph('<b>Suggested acceptance rules</b> (agree your own before the pilot): wrong-person records = 0; impostor accepted = 0; spoof recorded = 0 for photos, screens and videos; correct rate and false-reject rate at a level management accepts. The anti-spoof models are not a guarantee, so any recorded spoof must be decided on before go-live.', P('', fontSize=8, leading=10.5))],
                    [Paragraph('<b>If the numbers are poor:</b> first fix light, camera height and enrollment quality, then run tools/evaluate_accuracy.py with photos taken at the kiosk and set FACE_MATCH_THRESHOLD from the data.', P('', fontSize=8, leading=10.5))]], colWidths=[CW],
                   style=TableStyle([('BACKGROUND', (0, 0), (-1, -1), YEL_T), ('LINEBEFORE', (0, 0), (0, -1), 3, YEL), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)])))
    # ---- M
    s.append(PageBreak())
    s += section_head('M', 'Defect log and sign-off',
                      'Log every Fail here, then complete the results summary and approvals.')
    s.append(Paragraph('Defect log', S_H2))
    cwd = [0.35*inch, 0.7*inch, 2.9*inch, 0.8*inch, 0.8*inch]
    cwd.append(CW-sum(cwd))
    data = [[th(h) for h in ['#', 'Test ID', 'What happened (steps, message, time)',
                             'Severity', 'Status', 'Fixed in / retest']]]
    for i in range(1, 11):
        data.append([Paragraph(str(i), S_B), '', '', '', '', ''])
    t = Table(data, colWidths=cwd, repeatRows=1,
              rowHeights=[None]+[0.36*inch]*10)
    st = base_style(len(data))
    st += [('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEAFTER', (0, 0),
                                                    (-2, -1), 0.5, LINE), ('BACKGROUND', (0, 1), (0, -1), YEL_T)]
    t.setStyle(TableStyle(st))
    s.append(t)
    s.append(PageBreak())
    s.append(Paragraph('Results and sign-off', P('',
             fontName='Helvetica-Bold', fontSize=15, leading=18, spaceAfter=7)))
    rows = [[l, t, str(len(ts)), '', '', ''] for l, t, _, ts in SECTIONS]
    cws = [0.7*inch, CW-0.7*inch-4*0.85*inch,
           0.85*inch, 0.85*inch, 0.85*inch, 0.85*inch]
    rows.append([Paragraph('Total', P('', fontName='Helvetica-Bold', textColor=YEL)),
                '', Paragraph('106', P('', fontName='Helvetica-Bold', textColor=YEL)), '', '', ''])
    t = simple_table(['Section', 'Area', 'Tests', 'Passed', 'Failed', 'Not run'], rows, cws,
                     extra=[('BACKGROUND', (0, 1), (0, -2), YEL_T), ('LINEAFTER', (0, 1), (0, -1), 1.5, YEL), ('BACKGROUND', (0, -1), (-1, -1), BLACK), ('LINEAFTER', (2, 1), (4, -1), 0.5, LINE), ('TOPPADDING', (0, 1), (-1, -1), 6), ('BOTTOMPADDING', (0, 1), (-1, -1), 6)])
    s.append(t)
    s.append(Spacer(1, 12))
    s.append(Table([[Paragraph('<b>GO-LIVE RULES</b> (edit to suit)', P('', fontSize=8.2, textColor=GREY))],
                    [Paragraph('Every test passed, or has a written exception accepted by the approver; no open Blocker or Major defect; accuracy pilot sheets completed and accepted; backup and restore rehearsed; FACE_DATA_KEY stored safely off the server.', P('', fontSize=9.2, leading=12.5))]], colWidths=[CW],
                   style=TableStyle([('BACKGROUND', (0, 0), (-1, -1), YEL_T), ('LINEBEFORE', (0, 0), (0, -1), 4, YEL), ('BOX', (0, 0), (-1, -1), 0.6, YEL_D), ('LEFTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (0, 0), 7), ('BOTTOMPADDING', (0, -1), (-1, -1), 9)])))
    s.append(Spacer(1, 14))
    cwr = [1.55*inch, 1.5*inch, 1.25*inch, 1.6*inch]
    cwr.append(CW-sum(cwr))
    data = [[th(h) for h in ['Role', 'Name',
                             'Decision (Accept / Reject)', 'Signature', 'Date']]]
    for r in ['Tester', 'System owner / HR', 'Manager approving go-live']:
        data.append([Paragraph(r, S_B), '', '', '', ''])
    t = Table(data, colWidths=cwr, rowHeights=[None]+[0.55*inch]*3)
    st = base_style(len(data))
    st += [('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEAFTER', (0, 0),
                                                    (-2, -1), 0.5, LINE), ('BACKGROUND', (0, 1), (0, -1), YEL_T)]
    t.setStyle(TableStyle(st))
    s.append(t)
    doc.build(s, canvasmaker=NumCanvas)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        # pass 1 records section page numbers for the contents table
        build(str(Path(tmp) / 'pass1.pdf'))
    build(OUT)
    print(
        f"E2E_TEST_PACK.pdf: {sum(len(s[3]) for s in SECTIONS)} cases, {len(pages)} sections")


if __name__ == "__main__":
    main()
