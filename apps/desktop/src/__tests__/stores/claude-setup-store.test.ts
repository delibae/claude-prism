import { describe, it, expect } from "vitest";

// advanceSteps is module-private — replicate for testing
type StepStatus = "pending" | "active" | "complete" | "error";

interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

function advanceSteps(
  steps: StepInfo[],
  targetId: string,
  order: string[],
): StepInfo[] {
  const targetIdx = order.indexOf(targetId);
  return steps.map((s) => {
    const thisIdx = order.indexOf(s.id);
    if (thisIdx < targetIdx && s.status !== "error") {
      return { ...s, status: "complete" as const };
    }
    if (s.id === targetId) {
      return { ...s, status: "active" as const };
    }
    return s;
  });
}

const INSTALL_ORDER = ["downloading", "installing", "verifying", "complete"];

function makeSteps(statuses: StepStatus[]): StepInfo[] {
  return [
    { id: "downloading", label: "Downloading", status: statuses[0] },
    { id: "installing", label: "Installing", status: statuses[1] },
    { id: "verifying", label: "Verifying", status: statuses[2] },
    { id: "complete", label: "Complete", status: statuses[3] },
  ];
}

describe("advanceSteps", () => {
  it("sets target step to active", () => {
    const steps = makeSteps(["pending", "pending", "pending", "pending"]);
    const result = advanceSteps(steps, "downloading", INSTALL_ORDER);
    expect(result[0].status).toBe("active");
    expect(result[1].status).toBe("pending");
    expect(result[2].status).toBe("pending");
    expect(result[3].status).toBe("pending");
  });

  it("marks earlier steps as complete", () => {
    const steps = makeSteps(["active", "pending", "pending", "pending"]);
    const result = advanceSteps(steps, "installing", INSTALL_ORDER);
    expect(result[0].status).toBe("complete");
    expect(result[1].status).toBe("active");
    expect(result[2].status).toBe("pending");
    expect(result[3].status).toBe("pending");
  });

  it("marks all earlier steps complete when advancing to last", () => {
    const steps = makeSteps(["active", "pending", "pending", "pending"]);
    const result = advanceSteps(steps, "complete", INSTALL_ORDER);
    expect(result[0].status).toBe("complete");
    expect(result[1].status).toBe("complete");
    expect(result[2].status).toBe("complete");
    expect(result[3].status).toBe("active");
  });

  it("does not overwrite error status on earlier steps", () => {
    const steps = makeSteps(["error", "pending", "pending", "pending"]);
    const result = advanceSteps(steps, "verifying", INSTALL_ORDER);
    expect(result[0].status).toBe("error"); // preserved
    expect(result[1].status).toBe("complete");
    expect(result[2].status).toBe("active");
    expect(result[3].status).toBe("pending");
  });

  it("keeps later steps as pending", () => {
    const steps = makeSteps(["pending", "pending", "pending", "pending"]);
    const result = advanceSteps(steps, "installing", INSTALL_ORDER);
    expect(result[2].status).toBe("pending");
    expect(result[3].status).toBe("pending");
  });

  it("works with login steps", () => {
    const loginOrder = ["opening-browser", "waiting-auth", "complete"];
    const loginSteps: StepInfo[] = [
      { id: "opening-browser", label: "Opening browser", status: "active" },
      { id: "waiting-auth", label: "Waiting", status: "pending" },
      { id: "complete", label: "Done", status: "pending" },
    ];
    const result = advanceSteps(loginSteps, "waiting-auth", loginOrder);
    expect(result[0].status).toBe("complete");
    expect(result[1].status).toBe("active");
    expect(result[2].status).toBe("pending");
  });
});
