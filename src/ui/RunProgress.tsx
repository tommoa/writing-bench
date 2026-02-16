import React from "react";
import { Box, Text } from "ink";

interface RunProgressProps {
  done: number;
  total: number;
  width?: number;
}

export function RunProgress({ done, total, width = 40 }: RunProgressProps) {
  const pct = total > 0 ? done / total : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;

  return (
    <Box>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(empty)}</Text>
      <Text color="gray">
        {"  "}
        {done}/{total}
      </Text>
    </Box>
  );
}
