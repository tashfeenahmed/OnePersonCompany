/** Multicolour variants of the bundled Google marks, rendered locally. */
export const COLOR_SERVICE_MARKS: Record<
  string,
  { background: string; svg: string }
> = {
  gmail: {
    background: "#ffffff",
    svg: '<path fill="#4285F4" d="M1.636 21.002h3.819V11.73L0 7.639v11.727c0 .904.732 1.636 1.636 1.636Z"/><path fill="#34A853" d="M18.545 21.002h3.819c.904 0 1.636-.732 1.636-1.636V7.639l-5.455 4.091Z"/><path fill="#FBBC04" d="M18.545 4.639v7.091L24 7.639V5.457c0-2.023-2.309-3.178-3.927-1.964Z"/><path fill="#EA4335" d="M5.455 11.73V4.639L12 9.548l6.545-4.909v7.091L12 16.639Z"/><path fill="#C5221F" d="M0 5.457v2.182l5.455 4.091V4.639L3.927 3.493C2.309 2.279 0 3.434 0 5.457Z"/>',
  },
  googleplay: {
    background: "#ffffff",
    svg: '<path fill="#FBBC04" d="M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594Z"/><path fill="#4285F4" d="M1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087Z"/><path fill="#34A853" d="M13.544 10.989l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179Z"/><path fill="#EA4335" d="M13.544 13.056l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54Z"/>',
  },
};
