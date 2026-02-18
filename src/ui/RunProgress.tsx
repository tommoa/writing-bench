import React from "react";
import { Box, Text } from "ink";

interface RunProgressProps {
  progress: number;
  opsDone: number;
  width?: number;
}

export function RunProgress({ progress, opsDone, width = 40 }: RunProgressProps) {
  const clamped = Math.min(1, Math.max(0, progress));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const expectedOps = clamped > 0.01
    ? Math.round(opsDone / clamped)
    : undefined;

  return (
    <Box>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(empty)}</Text>
      <Text color="gray">
        {"  "}
        {Math.round(clamped * 100)}%{"  "}
        {expectedOps != null
          ? `${opsDone}/~${expectedOps} ops`
          : `${opsDone} ops`}
      </Text>
    </Box>
  );
}
