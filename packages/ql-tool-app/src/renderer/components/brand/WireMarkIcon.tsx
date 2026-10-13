import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon"

/** Props of {@link WireMarkIcon}. */
export interface WireMarkIconProps extends SvgIconProps {
  /** Render white in the dark scheme (the site's `dark:text-white`) — the toolbar mark. */
  whiteInDark?: boolean
}

/**
 * The Wire "W" mark (path copied verbatim from docs.wire.network; the same path
 * as `resources/assets/brand/wire-mark.svg`, asserted equal by a test), brand blue.
 *
 * @param props - SvgIcon props plus {@link WireMarkIconProps.whiteInDark}.
 * @returns The icon.
 */
export function WireMarkIcon({ whiteInDark = false, sx, ...props }: WireMarkIconProps) {
  return (
    <SvgIcon
      viewBox={WireMark.ViewBox}
      titleAccess={WireMark.Title}
      sx={[
        theme => ({
          color: theme.palette.primary.main,
          ...(whiteInDark && theme.applyStyles("dark", { color: theme.palette.common.white }))
        }),
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
      {...props}
    >
      <path fill="currentColor" d={WireMark.PathData} />
    </SvgIcon>
  )
}

/** The mark's geometry. */
export namespace WireMark {
  /** The centered square viewBox around the 44.9 × 22 mark. */
  export const ViewBox = "-5.55 -17 56 56"
  /** Accessible title. */
  export const Title = "Wire"
  /** The single path of the mark. */
  export const PathData =
    "M34.6238 22C34.6177 22 34.6126 22 34.6076 22C33.4789 21.9939 32.4724 21.3588 31.9818 20.3421L28.6946 13.5383L25.1886 20.3767C24.6756 21.3771 23.6253 21.999 22.4489 21.999C21.2724 21.999 20.2221 21.3771 19.7092 20.3767L16.2031 13.5383L12.9159 20.3421C12.4243 21.3588 11.4188 21.9939 10.2902 22C10.2851 22 10.279 22 10.2739 22C9.15237 22 8.14584 21.3771 7.64614 20.3716L0.427461 5.84706C-0.201489 4.58096 -0.133302 3.10724 0.611669 1.90627C1.35155 0.712435 2.62879 0 4.02815 0H8.68422C10.6871 0 12.5007 1.1114 13.4176 2.89961L16.14 8.20929L19.1077 2.06912C19.7265 0.78775 20.9762 0.0223908 22.4478 0.0223908C23.9195 0.0223908 25.1692 0.78775 25.789 2.07013L28.7567 8.21031L31.4791 2.90063C32.396 1.11242 34.2096 0.00101776 36.2125 0.00101776H40.8686C42.2679 0.00101776 43.5462 0.713453 44.285 1.90729C45.03 3.10927 45.0982 4.58198 44.4692 5.84909L37.2516 20.3736C36.7519 21.3792 35.7464 22.002 34.6238 22.002V22ZM30.0512 10.8901L34.119 19.309C34.2564 19.593 34.5149 19.6245 34.6198 19.6256H34.6228C34.7297 19.6256 34.9851 19.594 35.1235 19.3151L42.3412 4.79062C42.6058 4.25833 42.5783 3.66294 42.2649 3.15711C41.9565 2.66044 41.4476 2.37546 40.8665 2.37546H36.2105C35.1032 2.37546 34.0997 2.99223 33.5909 3.98353L30.0502 10.8901H30.0512ZM4.02815 2.37546C3.44805 2.37546 2.93817 2.66044 2.62981 3.15711C2.31635 3.66192 2.28887 4.25731 2.55348 4.79062L9.77114 19.3151C9.91158 19.5971 10.1711 19.6256 10.2749 19.6256C10.3797 19.6256 10.6382 19.593 10.7756 19.309L14.8435 10.8901L11.3028 3.98353C10.7939 2.99121 9.79048 2.37546 8.6832 2.37546H4.02713H4.02815ZM17.4977 10.8585L21.822 19.2927C21.9797 19.6001 22.341 19.6235 22.4478 19.6235C22.5852 19.6235 22.9211 19.591 23.0737 19.2927L27.398 10.8585L23.6498 3.10316C23.3424 2.46604 22.7063 2.39785 22.4478 2.39785C22.1893 2.39785 21.5533 2.46706 21.2459 3.10316L17.4977 10.8585Z"
}
