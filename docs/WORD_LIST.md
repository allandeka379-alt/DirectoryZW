# Reviewing the word list

The assistant reads customers' requests with a word list (the lexicon): what each word means, and what it does in a request. The English words were written and checked by the development team. **The Shona list (about 460 words and verb roots) and the Ndebele list (about 300) are first drafts by the developers, who aren't native speakers.**

A Shona or Ndebele word starts as a draft. Until someone approves it, a request that depends on it gets a question: "Just to check, do you mean *Cakes and baking*?" Once a native speaker approves the word, such requests are answered straight away. So the review makes the assistant faster for Shona and Ndebele speakers, and it keeps wrong words from ever giving a confident wrong answer.

## How to review

**In the admin portal** (any team account):
1. Open **Word list**, choose **Shona** (or **Ndebele**) and **To review**.
2. For each word, read **Meaning** and **What it does**.
3. Tick the words that are right, then press **Approve ticked**. Press **Wrong** on a word that's wrong.
4. To correct a word, open **Add a word, or correct what one means** at the bottom. Enter the word with the right meaning and category, and save. A saved word counts as approved.

**Offline:** press **Download as a spreadsheet**, fill in the "Your correction" column, and send it back to the team to enter in the admin portal.

"Customers agreed" shows how many customers picked the word's category when the assistant asked them. It's a helpful hint, not proof.

## What to check

- **Is it a word people really use** when they ask for this, in any common spelling? Add the other spellings you see (for example "friji" as well as "firiji").
- **Is the meaning right?** Check it against the English in **Meaning**.
- **Does it point to the right category?** A word that can mean two things should list both. For example, "macheya" (chairs) could be to hire or to buy; the assistant then asks the customer.
- **Could it mean something else, or offend?** Reject it if a common meaning would send customers to the wrong businesses.

## What the roles mean

| Role | What it does | Examples |
| --- | --- | --- |
| service, product | Decides the category | keke (cake), makanika (mechanic), matende (tents) |
| general word | Only decides when nothing more specific is said | mota (car), imba (house), mvura (water) |
| brand | Only narrows | Toyota, Samsung |
| occasion | Only narrows | muchato (wedding), mariro (funeral) |
| action | Changes the category of the thing it's about | gadzira (repair or make): "anogadzira firiji" is appliance repairs |
| detail | Ignored when choosing a category | diki (small), nyowani (new) |
| filler | Ignored | ndoda (I want), ndapota (please), yangu (my) |

## Verb roots

Verbs are listed by their root, such as "gadzir", with example forms (kugadzira, anogadzira, mugadziri). The assistant recognises the root with the usual prefixes and endings. When reviewing a root, check:
- the example forms are real words with the meaning shown
- no common word that contains the root means something else. If one does, tell the developers; they can list that word separately.

The action rules are in the code (`src/ai/rules.ts`), for example repair + phone = phone repairs. If a rule gives a wrong result in Shona or Ndebele, tell the developers.

## Where to start

1. **Verb roots** (they affect many words):
   - Shona: gadzir, teng, roj, takur, tam, cher, vak, pend, son, bik, chenes, wach
   - Ndebele: lungis, theng, qash, thuth, akh, gebh, pend, thung, phek, hlanz, wash
2. Words for the busiest categories: phones, phone and appliance repairs, event hire, building materials, rentals, cars.
3. **Fillers**: words that should be ignored, but might carry meaning.

## Ndebele: nouns are listed with their prefix

Ndebele nouns are listed as people say them alone ("ifriji", "amathende", "umtshado"). The assistant also recognises them:
- after "of" and "and", which swallow the first vowel: "ikhekhe **lo**mtshado" (la + umtshado), "inyama **ye**nkomo" (ya + inkomo)
- as places with e- and -ini: "emtshadweni" (at the wedding)
- on borrowed words with a prefix: "ifridge", "amatyres"

So check the word as said alone, and tell the developers about common forms it misses.

## Missing words

Add them under **Add a word, or correct what one means**. The **Vocabulary** screen's **Suggested words** lists words customers used that the assistant didn't know, and what they turned out to mean. They're good candidates to add.

## Seeing how a message is read

A developer can run `npm run explain -- "ndoda keke remuchato ku Budiriro"`. It shows each word's role, how the category was reached, and whether the assistant would answer, ask, or pass the message on.
