import { c as _c } from "react/compiler-runtime";
import axios from 'axios';
import React, { useEffect, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Spinner } from '../components/Spinner.js';
import { getOauthConfig } from '../constants/oauth.js';
import { useTimeout } from '../hooks/useTimeout.js';
import { Box, Text } from '../ink.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { getUserAgent } from './http.js';
import { logError } from './log.js';
export interface PreflightCheckResult {
  success: boolean;
  error?: string;
  sslHint?: string;
}
async function checkEndpoints(): Promise<PreflightCheckResult> {
  // Network preflight is a Limkenion-service connectivity check (远端服务).
  // We have intentionally dropped those services, so skip the check entirely:
  // any real connectivity issue will surface when the user actually tries to
  // reach a backend (DeepSeek), and bailing out here only produces an
  // "Unable to connect" REPL banner that then causes the process to exit
  // before the user can type anything.
  return { success: true }
}
interface PreflightStepProps {
  onSuccess: () => void;
}
export function PreflightStep(t0) {
  const $ = _c(12);
  const {
    onSuccess
  } = t0;
  const [result, setResult] = useState(null);
  const [isChecking, setIsChecking] = useState(true);
  const showSpinner = useTimeout(1000) && isChecking;
  let t1;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => {
      const run = async function run() {
        const checkResult = await checkEndpoints();
        setResult(checkResult);
        setIsChecking(false);
      };
      run();
    };
    t2 = [];
    $[0] = t1;
    $[1] = t2;
  } else {
    t1 = $[0];
    t2 = $[1];
  }
  useEffect(t1, t2);
  let t3;
  let t4;
  if ($[2] !== onSuccess || $[3] !== result) {
    t3 = () => {
      if (result?.success) {
        onSuccess();
      } else {
        if (result && !result.success) {
          const timer = setTimeout(_temp, 100);
          return () => clearTimeout(timer);
        }
      }
    };
    t4 = [result, onSuccess];
    $[2] = onSuccess;
    $[3] = result;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);
  let t5;
  if ($[6] !== isChecking || $[7] !== result || $[8] !== showSpinner) {
    t5 = isChecking && showSpinner ? <Box paddingLeft={1}><Spinner /><Text>Checking connectivity...</Text></Box> : !result?.success && !isChecking && <Box flexDirection="column" gap={1}><Text color="error">Unable to connect to Limkenion services</Text><Text color="error">{result?.error}</Text>{result?.sslHint ? <Box flexDirection="column" gap={1}><Text>{result.sslHint}</Text><Text color="suggestion">See </Text></Box> : <Box flexDirection="column" gap={1}><Text>Please check your internet connection and network settings.</Text><Text>Note: Limkenion might not be available in your country. Check supported countries at{" "}<Text color="suggestion"></Text></Text></Box>}</Box>;
    $[6] = isChecking;
    $[7] = result;
    $[8] = showSpinner;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  let t6;
  if ($[10] !== t5) {
    t6 = <Box flexDirection="column" gap={1} paddingLeft={1}>{t5}</Box>;
    $[10] = t5;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  return t6;
}
function _temp() {
  return process.exit(1);
}