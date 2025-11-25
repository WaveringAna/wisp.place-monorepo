import { createRoot } from 'react-dom/client'
import Layout from '@public/layouts'
import { Button } from '@public/components/ui/button'
import { Card } from '@public/components/ui/card'
import { ArrowLeft, Shield, AlertCircle, CheckCircle, Scale } from 'lucide-react'

function AcceptableUsePage() {
	return (
		<div className="min-h-screen bg-background">
			{/* Header */}
			<header className="border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
				<div className="container mx-auto px-4 py-4 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<img src="/transparent-full-size-ico.png" alt="wisp.place" className="w-8 h-8" />
						<span className="text-xl font-semibold text-foreground">
							wisp.place
						</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => window.location.href = '/'}
					>
						<ArrowLeft className="w-4 h-4 mr-2" />
						Back to Home
					</Button>
				</div>
			</header>

			{/* Hero Section */}
			<div className="bg-gradient-to-b from-accent/10 to-background border-b border-border/40">
				<div className="container mx-auto px-4 py-16 max-w-4xl text-center">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/20 mb-6">
						<Shield className="w-8 h-8 text-accent" />
					</div>
					<h1 className="text-4xl md:text-5xl font-bold mb-4">Acceptable Use Policy</h1>
					<div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
						<div className="flex items-center gap-2">
							<span className="font-medium">Effective:</span>
							<span>November 10, 2025</span>
						</div>
						<div className="h-4 w-px bg-border"></div>
						<div className="flex items-center gap-2">
							<span className="font-medium">Last Updated:</span>
							<span>November 10, 2025</span>
						</div>
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="container mx-auto px-4 py-12 max-w-4xl">
				<article className="space-y-12">
					{/* Our Philosophy */}
					<section>
						<h2 className="text-3xl font-bold mb-6 text-foreground">Our Philosophy</h2>
						<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
							<p>
								wisp.place exists to give you a corner of the internet that's truly yours—a place to create, experiment, and express yourself freely. We believe in the open web and the fundamental importance of free expression. We're not here to police your thoughts, moderate your aesthetics, or judge your taste.
							</p>
							<p>
								That said, we're also real people running real servers in real jurisdictions (the United States and the Netherlands), and there are legal and practical limits to what we can host. This policy aims to be as permissive as possible while keeping the lights on and staying on the right side of the law.
							</p>
						</div>
					</section>

					{/* What You Can Do */}
					<Card className="bg-green-500/5 border-green-500/20 p-8">
						<div className="flex items-start gap-4">
							<div className="flex-shrink-0">
								<CheckCircle className="w-8 h-8 text-green-500" />
							</div>
							<div className="space-y-4">
								<h2 className="text-3xl font-bold text-foreground">What You Can Do</h2>
								<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
									<p>
										<strong className="text-green-600 dark:text-green-400">Almost anything.</strong> Seriously. Build weird art projects. Write controversial essays. Create spaces that would make corporate platforms nervous. Express unpopular opinions. Make things that are strange, provocative, uncomfortable, or just plain yours.
									</p>
									<p>
										We support creative and personal expression in all its forms, including adult content, political speech, counter-cultural work, and experimental projects.
									</p>
								</div>
							</div>
						</div>
					</Card>

					{/* What You Can't Do */}
					<section>
						<div className="flex items-center gap-3 mb-6">
							<AlertCircle className="w-8 h-8 text-red-500" />
							<h2 className="text-3xl font-bold text-foreground">What You Can't Do</h2>
						</div>

						<div className="space-y-8">
							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Illegal Content</h3>
								<p className="text-muted-foreground mb-4">
									Don't host content that's illegal in the United States or the Netherlands. This includes but isn't limited to:
								</p>
								<ul className="space-y-3 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Child sexual abuse material (CSAM)</strong> involving real minors in any form</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Realistic or AI-generated depictions</strong> of minors in sexual contexts, including photorealistic renders, deepfakes, or AI-generated imagery</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Non-consensual intimate imagery</strong> (revenge porn, deepfakes, hidden camera footage, etc.)</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Content depicting or facilitating human trafficking, sexual exploitation, or sexual violence</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Instructions for manufacturing explosives, biological weapons, or other instruments designed for mass harm</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Content that facilitates imminent violence or terrorism</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Stolen financial information, credentials, or personal data used for fraud</span>
									</li>
								</ul>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Intellectual Property Violations</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										Don't host content that clearly violates someone else's copyright, trademark, or other intellectual property rights. We're required to respond to valid DMCA takedown notices.
									</p>
									<p>
										We understand that copyright law is complicated and sometimes ridiculous. We're not going to proactively scan your site or nitpick over fair use. But if we receive a legitimate legal complaint, we'll have to act on it.
									</p>
								</div>
							</Card>

							<Card className="p-6 border-2 border-red-500/30 bg-red-500/5">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Hate Content</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										You can express controversial ideas. You can be offensive. You can make people uncomfortable. But pure hate—content that exists solely to dehumanize, threaten, or incite violence against people based on race, ethnicity, religion, gender, sexual orientation, disability, or similar characteristics—isn't welcome here.
									</p>
									<p>
										There's a difference between "I have deeply unpopular opinions about X" and "People like X should be eliminated." The former is protected expression. The latter isn't.
									</p>
									<div className="bg-background/50 border-l-4 border-red-500 p-4 rounded">
										<p className="font-medium text-foreground">
											<strong>A note on enforcement:</strong> While we're generally permissive and believe in giving people the benefit of the doubt, hate content is where we draw a hard line. I will be significantly more aggressive in moderating this type of content than anything else on this list. If your site exists primarily to spread hate or recruit people into hateful ideologies, you will be removed swiftly and without extensive appeals. This is non-negotiable.
										</p>
									</div>
								</div>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Adult Content Guidelines</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										Adult content is allowed. This includes sexually explicit material, erotica, adult artwork, and NSFW creative expression.
									</p>
									<p className="font-medium">However:</p>
									<ul className="space-y-2">
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No content involving real minors in any sexual context whatsoever</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No photorealistic, AI-generated, or otherwise realistic depictions of minors in sexual contexts</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-green-500 mt-1">•</span>
											<span>Clearly stylized drawings and written fiction are permitted, provided they remain obviously non-photographic in nature</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No non-consensual content (revenge porn, voyeurism, etc.)</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No content depicting illegal sexual acts (bestiality, necrophilia, etc.)</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-yellow-500 mt-1">•</span>
											<span>Adult content should be clearly marked as such if discoverable through public directories or search</span>
										</li>
									</ul>
								</div>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Malicious Technical Activity</h3>
								<p className="text-muted-foreground mb-4">Don't use your site to:</p>
								<ul className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Distribute malware, viruses, or exploits</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Conduct phishing or social engineering attacks</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Launch DDoS attacks or network abuse</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Mine cryptocurrency without explicit user consent</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Scrape, spam, or abuse other services</span>
									</li>
								</ul>
							</Card>
						</div>
					</section>

					{/* Our Approach to Enforcement */}
					<section>
						<div className="flex items-center gap-3 mb-6">
							<Scale className="w-8 h-8 text-accent" />
							<h2 className="text-3xl font-bold text-foreground">Our Approach to Enforcement</h2>
						</div>
						<div className="space-y-6">
							<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
								<p>
									<strong>We actively monitor for obvious violations.</strong> Not to censor your creativity or police your opinions, but to catch the clear-cut stuff that threatens the service's existence and makes this a worse place for everyone. We're looking for the blatantly illegal, the obviously harmful—the stuff that would get servers seized and communities destroyed.
								</p>
								<p>
									We're not reading your blog posts looking for wrongthink. We're making sure this platform doesn't become a haven for the kind of content that ruins good things.
								</p>
							</div>

							<Card className="p-6 bg-muted/30">
								<p className="font-semibold mb-3 text-foreground">We take action when:</p>
								<ol className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">1.</span>
										<span>We identify content that clearly violates this policy during routine monitoring</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">2.</span>
										<span>We receive a valid legal complaint (DMCA, court order, etc.)</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">3.</span>
										<span>Someone reports content that violates this policy and we can verify the violation</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">4.</span>
										<span>Your site is causing technical problems for the service or other users</span>
									</li>
								</ol>
							</Card>

							<Card className="p-6 bg-muted/30">
								<p className="font-semibold mb-3 text-foreground">When we do need to take action, we'll try to:</p>
								<ul className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Contact you first when legally and practically possible</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Be transparent about what's happening and why</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Give you an opportunity to address the issue if appropriate</span>
									</li>
								</ul>
							</Card>

							<p className="text-muted-foreground">
								For serious or repeated violations, we may suspend or terminate your account.
							</p>
						</div>
					</section>

					{/* Regional Compliance */}
					<Card className="p-6 bg-blue-500/5 border-blue-500/20">
						<h2 className="text-2xl font-bold mb-4 text-foreground">Regional Compliance</h2>
						<p className="text-muted-foreground">
							Our servers are located in the United States and the Netherlands. Content hosted on wisp.place must comply with the laws of both jurisdictions. While we aim to provide broad creative freedom, these legal requirements are non-negotiable.
						</p>
					</Card>

					{/* Changes to This Policy */}
					<section>
						<h2 className="text-2xl font-bold mb-4 text-foreground">Changes to This Policy</h2>
						<p className="text-muted-foreground">
							We may update this policy as legal requirements or service realities change. If we make significant changes, we'll notify active users.
						</p>
					</section>

					{/* Questions or Reports */}
					<section>
						<h2 className="text-2xl font-bold mb-4 text-foreground">Questions or Reports</h2>
						<p className="text-muted-foreground">
							If you have questions about this policy or need to report a violation, contact us at{' '}
							<a
								href="mailto:contact@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								contact@wisp.place
							</a>
							.
						</p>
					</section>

					{/* Final Message */}
					<Card className="p-8 bg-accent/10 border-accent/30 border-2">
						<p className="text-lg leading-relaxed text-foreground">
							<strong>Remember:</strong> This policy exists to keep the service running and this community healthy, not to limit your creativity. When in doubt, ask yourself: "Is this likely to get real-world authorities knocking on doors or make this place worse for everyone?" If the answer is yes, it probably doesn't belong here. Everything else? Go wild.
						</p>
					</Card>
				</article>
			</div>

			{/* Footer */}
			<footer className="border-t border-border/40 bg-muted/20 mt-12">
				<div className="container mx-auto px-4 py-8">
					<div className="text-center text-sm text-muted-foreground">
						<p>
							Built by{' '}
							<a
								href="https://bsky.app/profile/nekomimi.pet"
								target="_blank"
								rel="noopener noreferrer"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								@nekomimi.pet
							</a>
							{' • '}
							Contact:{' '}
							<a
								href="mailto:contact@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								contact@wisp.place
							</a>
							{' • '}
							Legal/DMCA:{' '}
							<a
								href="mailto:legal@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								legal@wisp.place
							</a>
						</p>
						<p className="mt-2">
							<a
								href="/acceptable-use"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								Acceptable Use Policy
							</a>
						</p>
					</div>
				</div>
			</footer>
		</div>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<AcceptableUsePage />
	</Layout>
)
