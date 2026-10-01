# Photo credits

This file records every photo used on the public website. The files are in `public/site/assets/` and served at `/assets/site/<name>`. Each photo was downloaded once from its source page and is served from our own server. Pages make no requests to the photo libraries.

All files are WebP, made with sharp: cropped, graded, resized (never upscaled) and saved at quality 40 to 66, effort 6, with metadata stripped. The build script is kept outside the repository; the crops and edits below are enough to repeat it.

The set shows formal businesses: a shopper reading her phone in a supermarket aisle with her trolley, a pharmacy counter, a furniture showroom, a tile and building-supply store, a solar installation crew in matching uniforms fitting panels on a roof, a woman in a beauty shop, the Harare city centre and a shop owner at the counter of his jewellery and accessories shop. It replaced an earlier set of street and market photos on 2026-10-01; two later reviews the same day replaced six more (see "Retired photos" below).

## Attribution on the site

One photo is CC BY-SA 4.0 and needs credit. The home page footer carries this line:

> Photo of Harare: Brandon Mushori, via Wikimedia Commons, CC BY-SA 4.0, cropped and adjusted. Other photos from Pexels.

The name links to its Commons file page, and "CC BY-SA 4.0" links to the licence. Our edited version of that photo is shared under the same licence, CC BY-SA 4.0.

The Pexels photos need no credit. They are listed here only for the record.

Rules for every photo:
- Never caption a photo with a place unless the place is confirmed as Zimbabwe.
- Never present a person in a photo as a customer, partner or staff member. No badge, seal or label sits on a photo of a person.
- The asks tiles carry category names only.
- No legible real brand logos or shop names.

## Photos

| Use | Files | Photographer | Source | Licence | Attribution required |
|---|---|---|---|---|---|
| Home hero background (wide screens, 3:2) | `photo-hero-shopper-phone-1280.webp`, `-1920.webp`, `-2560.webp` | Gustavo Fring | [Pexels 4971954](https://www.pexels.com/photo/a-woman-with-a-shopping-cart-4971954/) | [Pexels License](https://www.pexels.com/license/) | No |
| Home hero background (phones, 4:5) | `photo-hero-shopper-phone-portrait-640.webp`, `-960.webp` | Gustavo Fring | same photo as above | [Pexels License](https://www.pexels.com/license/) | No |
| Asks tile "Pharmacies" (4:3) | `photo-cat-pharmacy-counter-400.webp`, `-800.webp` | Valdans Media | [Pexels 13003793](https://www.pexels.com/photo/13003793/) | [Pexels License](https://www.pexels.com/license/) | No |
| Asks tile "Furniture" (4:3) | `photo-cat-furniture-showroom-400.webp`, `-800.webp` | Max Vakhtbovych | [Pexels 6969830](https://www.pexels.com/photo/6969830/) | [Pexels License](https://www.pexels.com/license/) | No |
| Asks tile "Tiles and building supplies" (4:3) | `photo-cat-building-supplies-400.webp`, `-800.webp` | Mochammad Algi | [Pexels 12340558](https://www.pexels.com/photo/12340558/) | [Pexels License](https://www.pexels.com/license/) | No |
| Asks tile "Solar installers" (4:3) | `photo-cat-solar-array-400.webp`, `-800.webp` | Hoan Ngọc | [Pexels 6961085](https://www.pexels.com/photo/6961085/) | [Pexels License](https://www.pexels.com/license/) | No |
| Trust section (1:1, shown 4:3 on phones) | `photo-trust-beauty-shop-480.webp`, `-800.webp` | RDNE Stock project | [Pexels 7755536](https://www.pexels.com/photo/a-woman-looking-at-beauty-products-on-a-shelf-7755536/) | [Pexels License](https://www.pexels.com/license/) | No |
| Final call to action background (wide screens, 7:3) | `photo-cta-harare-skyline-768.webp`, `-1280.webp`, `-1600.webp` | Brandon Mushori | [Harare movers and shakers](https://commons.wikimedia.org/wiki/File:Harare_movers_and_shakers.jpg) (Wikimedia Commons) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | **Yes** |
| Final call to action background (phones, 5:6) | `photo-cta-harare-skyline-portrait-480.webp`, `-720.webp` | Brandon Mushori | same photo as above | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | **Yes** |
| Register page aside (3:2) | `photo-register-jewellery-counter-480.webp`, `-800.webp` | Kampus Production | [Pexels 8201192](https://www.pexels.com/photo/8201192/) | [Pexels License](https://www.pexels.com/license/) | No |

## Changes made to each photo

Crops are given in pixels of the file that was downloaded, then snapped to the exact aspect ratio around the same centre. "Brightness" and "saturation" are sharp `modulate` values. "Contrast a, b" is sharp `linear(a, b)`. "Highlights compressed above N by S" means channel values above N were scaled by S, so bright whites do not glare on the dark site. "Top darkened" is a graduated darkening from the top edge.

- **Shopper reading her phone, hero (6000x4000, the full-size original).**
  - Wide screens: crop x 2100 to 6000, y 150 to 2750 (3:2). The page shows it at `object-position: 50% 63%` (84% 63% from 1024 to 1279px), so her face sits in the gap between the headline and the chat phone and the orange handle of her trolley shows near the bottom of the hero. The lit chiller cabinets on the left sit under the copy. A soft dark ellipse in the hero overlay calms the bottom-left corner under the button.
  - Phones: crop x 2800 to 6000, full height (4:5). It shows as a band above the headline, with her face and phone clear of the text.
  - Edits: brightness 0.80 (wide) and 0.84 (phones), saturation 0.92, highlights compressed above 165 by 0.6.
  - The source does not name a place, so the photo carries no place caption.
- **Pharmacy counter (2000x2799, downloaded at 2000 px wide).**
  - Crop x 0 to 1540, y 0 to 1155 (4:3): the man at the counter and the glass shelves of medicine boxes behind him. The right edge stops before a branded display stand.
  - Edits: brightness 0.80, saturation 1.0, contrast 1.08, -8, highlights compressed above 165 by 0.5.
  - The scouting notes place it in Kampala, so the tile carries no place caption.
- **Furniture showroom (4787x3191).**
  - Crop x 287 to 4542, full height.
  - Edits: brightness 0.95, saturation 0.9.
- **Tile and building-supply store (2983x3977, downloaded at 2000x2666; crop given in the full-size pixels).**
  - Crop x 0 to 2685, y 1700 to 3714 (4:3). The sample slabs and the boxed tiles fill the frame; only a sliver of the far store shows at the top.
  - Edits: a feathered blur over the top 10% of the crop (that sliver of far shelving), so no brand logo is legible; top darkened over 30% of the height, 55% at the top edge; brightness 0.92, saturation 0.95.
  - The photo was taken outside Zimbabwe, so it carries no place caption.
- **Solar installation crew (2400x1600, downloaded at 2400 px wide).**
  - Crop x 80 to 1546, y 400 to 1500 (4:3): two installers in matching orange uniforms kneeling on a roof of installed panels, with the cell side of the panels in full view and trees behind.
  - Edits: a feathered blur over the lettering on the back of one uniform; brightness 0.90, saturation 0.92, highlights compressed above 190 by 0.6.
  - Their faces are hidden by their hats. The source does not name a place, so the tile carries no place caption.
- **Woman in a beauty shop (6451x4301).**
  - Square crop x 2150 to 6451, full height.
  - Edits: brightness 0.82, saturation 0.85.
- **Harare skyline (4000x3000).**
  - Before cropping: the bank sign on a parapet in the middle of the frame (x 1944 to 2168, y 1496 to 1522) and two boards on a low wall near the bottom left (x 612 to 704 and 758 to 842, y 1786 to 1824) are painted over with the concrete colour around them, with a little of the photo's own grain, instead of blurred (a blur had left a red smudge beside the copy). Two other small rooftop signs are softened with a feathered Gaussian blur, and a median filter removes one sensor dust spot in the sky.
  - Wide screens: crop x 301 to 2850, y 800 to 1893 (7:3). The towers fill the lower two thirds; the bottom edge stays above the minibus rank and the large store sign on the low building.
  - Phones: crop x 1700 to 2700, y 693 to 1893 (5:6), centred on the towers in the middle of the frame.
  - Edits: brightness 0.75, saturation 0.8.
- **Shop owner at his jewellery counter (1400x935, downloaded at 1400 px wide).**
  - Full frame (3:2): the owner working at a glass display counter of watches and jewellery, with handbags on display at the right. The register card shows it at `object-position: 50% 50%`, with the fade into the card starting at 70% of its height so the counter stays in view.
  - Edits: brightness 0.78, saturation 0.95, highlights compressed above 165 by 0.55.
  - The source does not name a place, so the photo carries no place caption.

## Weights

| File | Bytes |
|---|---|
| photo-hero-shopper-phone-1280.webp | 47,024 |
| photo-hero-shopper-phone-1920.webp | 82,352 |
| photo-hero-shopper-phone-2560.webp | 125,858 |
| photo-hero-shopper-phone-portrait-640.webp | 31,836 |
| photo-hero-shopper-phone-portrait-960.webp | 44,444 |
| photo-cat-pharmacy-counter-400.webp | 9,868 |
| photo-cat-pharmacy-counter-800.webp | 21,844 |
| photo-cat-furniture-showroom-400.webp | 14,574 |
| photo-cat-furniture-showroom-800.webp | 45,258 |
| photo-cat-building-supplies-400.webp | 17,198 |
| photo-cat-building-supplies-800.webp | 54,574 |
| photo-cat-solar-array-400.webp | 20,788 |
| photo-cat-solar-array-800.webp | 56,260 |
| photo-trust-beauty-shop-480.webp | 15,510 |
| photo-trust-beauty-shop-800.webp | 32,070 |
| photo-cta-harare-skyline-768.webp | 21,668 |
| photo-cta-harare-skyline-1280.webp | 52,966 |
| photo-cta-harare-skyline-1600.webp | 84,432 |
| photo-cta-harare-skyline-portrait-480.webp | 17,894 |
| photo-cta-harare-skyline-portrait-720.webp | 28,490 |
| photo-register-jewellery-counter-480.webp | 10,838 |
| photo-register-jewellery-counter-800.webp | 22,982 |

## Retired photos

Their files are no longer in the repository.

Removed on 2026-10-01 because they showed street trading, markets and informal workshops rather than the formal businesses we are onboarding:

| Former use | Former files | Photographer | Source | Licence |
|---|---|---|---|---|
| Home hero | `photo-hero-harare-jacaranda-*` | lumoplank | [Harare - Harare3496](https://commons.wikimedia.org/wiki/File:Harare_-_Harare3496.jpg) | CC0 1.0 |
| Asks tile "Auto parts and repairs" | `photo-cat-auto-repairs-*` | dionisio castigotivane | [Pexels 28153669](https://www.pexels.com/photo/28153669/) | Pexels License |
| Asks tile "Fruit and vegetables" | `photo-cat-fruit-veg-harare-*` | Cecil Dzwowa | [Carts loaded with fruits and vegetables for sale in Harare](https://commons.wikimedia.org/wiki/File:Carts_loaded_with_fruits_and_vegetables_for_sale_in_Harare.jpg) | CC BY-SA 4.0 |
| Asks tile "Furniture and woodwork" | `photo-cat-furniture-woodwork-*` | Themba Mtegha | [Pexels 20317629](https://www.pexels.com/photo/20317629/) | Pexels License |
| Asks tile "Solar" | `photo-cat-solar-*` | Khaya Motsa | [Pexels 39382227](https://www.pexels.com/photo/39382227/) | Pexels License |
| Trust section | `photo-trust-craft-market-*` | Kudakwashe Engels Chingono | [Craftsman working at his stall](https://commons.wikimedia.org/wiki/File:Craftsman_working_at_his_stall.jpg) | CC BY-SA 4.0 |
| Final call to action | `photo-cta-dawn-highfield-*` | Achitate | [Dawn in Highfield Harare 1](https://commons.wikimedia.org/wiki/File:Dawn_in_Highfield_Harare_1.jpg) | CC BY-SA 4.0 |
| Register page aside | `photo-register-shopkeeper-*` | Bruno César | [Pexels 17125158](https://www.pexels.com/photo/17125158/) | Pexels License |

Removed later on 2026-10-01 after review:

| Former use | Former files | Photographer | Source | Licence | Why |
|---|---|---|---|---|---|
| Home hero | `photo-hero-shop-owner-call-*` | Kampus Production | [Pexels 8201200](https://www.pexels.com/photo/elderly-man-in-blue-long-sleeves-having-a-phone-call-while-writing-8201200/) | Pexels License | A voice call, not a customer asking on WhatsApp; the subject collided with the copy. |
| Asks tile "Solar installers" | `photo-cat-solar-installers-*` | Los Muertos Crew | [Pexels 8853536](https://www.pexels.com/photo/8853536/) | Pexels License | Taken outside Africa; faces turned away. |
| Register page aside | `photo-register-customer-phone-*` | Gustavo Fring | [Pexels 4971954](https://www.pexels.com/photo/a-woman-with-a-shopping-cart-4971954/) | Pexels License | The same photo now carries the home hero, so the register page shows a shop owner instead. |
| Asks tile "Pharmacies" | `photo-cat-pharmacy-*` | Ninthgrid | [Pexels 30678215](https://www.pexels.com/photo/african-customers-shopping-in-lagos-pharmacy-30678215/) | Pexels License | The original is blown out: the white wall and shelves stayed flat and milky after grading, and the man's head touched the top of the tile. |
| Asks tile "Solar installers" | `photo-cat-solar-crew-*` | SAgbley | [Solar installation technician](https://commons.wikimedia.org/wiki/File:Solar_installation_technician.jpg) (Wikimedia Commons, filed under solar energy in Ghana) | CC BY-SA 4.0 | The panel showed only its pale back against a flat sky, so the tile did not read as solar; its footer credit was removed with it. |
| Register page aside | `photo-register-boutique-owner-*` | Thirdman | [Pexels 8484031](https://www.pexels.com/photo/a-woman-in-yellow-dress-sitting-while-using-her-laptop-8484031/) | Pexels License | Her hair was cut by the top edge and the fade hid her laptop, so it read as a clothes rail at home rather than shop premises. |
