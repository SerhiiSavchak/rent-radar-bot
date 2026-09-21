export const RIELTOR_CITY_PREFIX = "lvov";
export const RIELTOR_ORIGIN = "https://rieltor.ua";

export const RIELTOR_FLATS_RENT_PATH = `/${RIELTOR_CITY_PREFIX}/flats-rent/`;
export const RIELTOR_HOUSES_RENT_PATH = `/${RIELTOR_CITY_PREFIX}/houses-rent/`;

export const RIELTOR_PAGE_SIZE = 20;
export const RIELTOR_MAX_PAGES_PER_CATEGORY = 2;
export const RIELTOR_REQUEST_GAP_MS = 2_000;

export type RieltorCategory = "apartment" | "house";

export type RieltorJsonLdOffer = {
  url?: string;
  availabilityStarts?: string;
  price?: number | string;
  priceCurrency?: string;
};

export type RieltorJsonLdItem = {
  url?: string;
  name?: string;
  description?: string;
  geo?: { latitude?: number | string; longitude?: number | string };
  address?: {
    addressLocality?: string;
    addressRegion?: string;
    streetAddress?: string;
  };
  offers?: RieltorJsonLdOffer;
  numberOfRooms?: number | string;
};
