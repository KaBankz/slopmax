import * as React from "react"

const mobileViewport = "(max-width: 767px)"

export function useIsMobile(beforeChange: (mobile: boolean) => void) {
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(mobileViewport).matches,
  )

  React.useLayoutEffect(() => {
    const viewport = window.matchMedia(mobileViewport)
    const onChange = (event: MediaQueryListEvent) => {
      beforeChange(event.matches)
      setIsMobile(event.matches)
    }
    viewport.addEventListener("change", onChange)
    setIsMobile(viewport.matches)
    return () => viewport.removeEventListener("change", onChange)
  }, [beforeChange])

  return isMobile
}
