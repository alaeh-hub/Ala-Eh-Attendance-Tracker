import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/ui";
import api from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { User } from "../../types";
import CaptureStep from "./CaptureStep";
import DoneStep from "./DoneStep";
import EmployeeStep from "./EmployeeStep";
import type { Step } from "./poses";
import Stepper from "./Stepper";

export default function FaceEnrollment() {
  const [params, setParams] = useSearchParams();
  const [step, setStep] = useState<Step>(1);
  const [employee, setEmployee] = useState<User | null>(null);

  // Deep link from the Employees page: /enroll?user=<id>
  useEffect(() => {
    const id = params.get("user");
    if (!id || employee?.id === id) return;
    api
      .get<User>(`/users/${id}`)
      .then((res) => {
        setEmployee(res.data);
        setStep(2);
      })
      .catch(() => toast.error("Employee not found"));
  }, [params, employee?.id]);

  function restart() {
    setEmployee(null);
    setStep(1);
    setParams({});
  }

  return (
    <>
      {/* The capture step takes over the whole screen, like the kiosk, so the header and stepper step aside. */}
      {step !== 2 && (
        <>
          <PageHeader title="Enroll employee" subtitle="Register an employee's details and face so they can clock in at the kiosk." />
          <Stepper step={step} />
        </>
      )}
      {step === 1 && (
        <EmployeeStep
          onReady={(u) => {
            setEmployee(u);
            setStep(2);
            setParams({ user: u.id });
          }}
        />
      )}
      {step === 2 && employee && <CaptureStep employee={employee} onBack={restart} onDone={(u) => { setEmployee(u); setStep(3); }} />}
      {step === 3 && employee && <DoneStep employee={employee} onAnother={restart} />}
    </>
  );
}
