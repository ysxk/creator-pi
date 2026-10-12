import mascotDarkUrl from "../assets/home-mascot-still-dark.png";
import mascotLightUrl from "../assets/home-mascot-still-light.png";

export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <img
        className="home-mascot-dark"
        src={mascotDarkUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
      <img
        className="home-mascot-light"
        src={mascotLightUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
    </span>
  );
}
