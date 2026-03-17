# Mapping Workshop Recording Script

Read this aloud in a natural, conversational tone — like you're debriefing after
a workshop, summarizing what everyone said. Single speaker throughout.

The transcript extractor needs: named people, concrete offers with quantities,
and needs with dollar amounts and fiat/flexible distinction.

Target: ~3 minutes. Record in a quiet room.

---

## Script

So I just got out of a resource mapping session for the Salish Sea bioregion, and
I want to capture what everyone committed to before I forget the details.

First, on my end — I'm Darren, I work with Regenerate Cascadia. I committed about
three hundred hours of knowledge curation work over the next six months. That
includes maintaining the knowledge graph, entity resolution, and processing meeting
transcripts. I'd value that at around five hundred dollars a month.

On the needs side, my server hosting runs about a hundred and fifty dollars a month,
and that has to be paid in cash — I can't cover the VPS bill with vouchers. I also
spend about fifty dollars a month on API credits for the AI tools, but I'm flexible
on that one — if someone can donate API keys, that works just as well.

Sarah from Victoria Landscape Hub made two big offers. She committed forty hours a
month of volunteer coordination across all the partner projects in the Greater Victoria
area. They've got about sixty regular volunteers, so that's real capacity. She also
offered their community workshop space on Pandora Avenue — available twice a week for
mapping sessions and skill shares. That space normally rents for about eight hundred
dollars a month, so it's a significant in-kind contribution.

Sarah's biggest need is covering the rent on that workshop space — fifteen hundred
dollars a month, and it has to be fiat because the landlord doesn't take anything else.
She also needs about three hundred a month for food for the volunteer crews, but she's
open to in-kind there — garden surplus, community meals, whatever works.

Then Randy from Kinship Earth brought some really valuable stuff. He's got four
portable soil monitoring kits — pH meters, moisture sensors, sampling tools — that
he can lend out on a quarterly rotation. Each kit is worth about two thousand dollars,
so they need to come back in working condition. He also offered eighty hours of
ecological assessment expertise over the next three months — watershed health surveys,
riparian zone mapping, species inventories. They've been doing this across the Salish
Sea for five years.

What Randy needs is data. If you borrow the kits, he wants the soil data reports back
to build a regional baseline. He also needs about two hundred dollars a month for
equipment maintenance and calibration, and that has to be cash since the parts come
from specific suppliers.

So in total, we've got knowledge curation, volunteer coordination, workshop space,
monitoring equipment, and ecological assessment on the commitment side. And the needs
break down into server costs, workshop rent, food for crews, and equipment maintenance.
Some of those are strictly fiat, some are substitutable. That's exactly the kind of
structure the commitment pool needs to route resources effectively.

---

## Expected Extraction Results

After recording, the extractor should find approximately:

**Commitments (offers):**
1. Darren / Regenerate Cascadia — Knowledge curation work (300 hours, ~$500/month, service)
2. Sarah / Victoria Landscape Hub — Volunteer coordination (40 hours/month, labor)
3. Sarah / Victoria Landscape Hub — Workshop space access (twice/week, ~$800/month, goods)
4. Randy / Kinship Earth — Soil monitoring equipment loan (4 kits, goods)
5. Randy / Kinship Earth — Ecological assessment expertise (80 hours, knowledge)

**Needs:**
1. Darren — Server hosting ($150/month, fiat_only=true, compute)
2. Darren — API credits ($50/month, fiat_only=false, compute)
3. Sarah — Workshop space rent ($1,500/month, fiat_only=true, housing)
4. Sarah — Volunteer crew food ($300/month, fiat_only=false, food)
5. Randy — Equipment maintenance ($200/month, fiat_only=true, equipment)

**Fiat-only threshold total:** $150 + $1,500 + $200 = $1,850/month
**Substitutable total:** $50 + $300 = $350/month
